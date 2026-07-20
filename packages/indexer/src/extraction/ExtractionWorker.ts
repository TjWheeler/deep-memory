import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { InvalidInputError } from '@utaba/deep-memory';
import type { ExtractionConfig, WorkerConfig } from '../types/config.js';
import type { ExtractionOutput, ExtractedEntity, ExtractedRelationship } from '../types/extraction.js';
import type { IndexSource } from '../types/source-list.js';
import type { LLMProvider } from '../providers/LLMProvider.js';
import { OpenAIChatProvider } from '../providers/OpenAIChatProvider.js';
import { isMarkdownStructured, splitIntoChapters, generateOverview, addChapterLineNumbers, type Chapter, type DocumentOverview } from './ChapterSplitter.js';
import { ProgressiveContext } from './ProgressiveContext.js';
import { PromptBuilder } from './PromptBuilder.js';
import type { ExtractionProgress, OnExtractionProgress, ExtractionCheckpoint } from './ExtractionProgress.js';

/** Callback type for checkpoint persistence */
export type OnCheckpoint = (checkpoint: ExtractionCheckpoint) => Promise<void>;

/** Error thrown when LLM output is truncated due to hitting maxOutputTokens */
class OutputTruncatedError extends Error {
  constructor(
    message: string,
    readonly responseContent: string,
    readonly usage?: { prompt_tokens: number; completion_tokens: number },
  ) {
    super(message);
    this.name = 'OutputTruncatedError';
  }
}

/** Default maximum characters per chunk when splitting large documents */
const DEFAULT_CHUNK_SIZE = 100_000;

/** Overlap between chunks to avoid missing entities at boundaries */
const CHUNK_OVERLAP = 2_000;

/**
 * Effective configuration used by ExtractionWorker, derived from either
 * a flat ExtractionConfig or a named WorkerConfig.
 */
interface EffectiveWorkerConfig {
  endpoint: string;
  model: string;
  maxChunkSize: number;
  maxTokens: number;
  temperature: number;
  extraBodyParams?: Record<string, unknown>;
  apiKey?: string;
  chunkingStrategy: 'auto' | 'chapters' | 'fixed';
  progressiveContextWindow: number;
  logDir?: string;
  workerName?: string;
  /** Undefined passes through; the built-in provider resolves the default (streaming on). */
  stream?: boolean;
  /** Undefined passes through; the built-in provider imposes no extra wall-clock cap. */
  requestTimeoutMs?: number;
}

/**
 * Handles extraction from a single source document.
 *
 * Reads the document, builds prompts, calls the configured LLM endpoint
 * (OpenAI-compatible chat completions), parses the JSON response, and
 * returns a structured ExtractionOutput.
 *
 * For large documents that exceed context limits, the worker splits the
 * document into chunks and merges extraction results.
 */
export class ExtractionWorker {
  private readonly promptBuilder: PromptBuilder;
  private readonly effective: EffectiveWorkerConfig;
  private readonly llmProvider: LLMProvider;
  private callSequence = 0;

  constructor(
    config: ExtractionConfig,
    vocabulary: string,
    extractionRules?: string,
    workerOverride?: WorkerConfig,
    logDir?: string,
    llmProvider?: LLMProvider,
    domainGuidance?: string,
  ) {
    this.promptBuilder = new PromptBuilder(vocabulary, extractionRules, domainGuidance);
    this.effective = workerOverride
      ? {
          endpoint: workerOverride.endpoint,
          model: workerOverride.model,
          maxChunkSize: workerOverride.maxChunkSize,
          maxTokens: workerOverride.maxOutputTokens,
          temperature: workerOverride.temperature ?? 0,
          extraBodyParams: workerOverride.extraBodyParams ?? config.extraBodyParams,
          apiKey: workerOverride.apiKey,
          chunkingStrategy: config.chunkingStrategy ?? 'auto',
          progressiveContextWindow: config.progressiveContextWindow ?? 6,
          logDir,
          workerName: workerOverride.name,
          stream: workerOverride.stream,
          requestTimeoutMs: workerOverride.requestTimeoutMs,
        }
      : {
          endpoint: config.endpoint,
          model: config.model,
          maxChunkSize: config.maxChunkSize ?? DEFAULT_CHUNK_SIZE,
          maxTokens: config.maxTokens ?? 4096,
          temperature: config.temperature ?? 0,
          extraBodyParams: config.extraBodyParams,
          chunkingStrategy: config.chunkingStrategy ?? 'auto',
          progressiveContextWindow: config.progressiveContextWindow ?? 6,
          logDir,
          stream: config.stream,
          requestTimeoutMs: config.requestTimeoutMs,
        };

    // Use the provided LLM provider, or fall back to built-in OpenAI-compat
    this.llmProvider = llmProvider ?? new OpenAIChatProvider({
      endpoint: this.effective.endpoint,
      apiKey: this.effective.apiKey,
      stream: this.effective.stream,
      requestTimeoutMs: this.effective.requestTimeoutMs,
    });
  }

  /**
   * Extract entities and relationships from a single source document.
   * Pass an AbortSignal to enable cancellation of in-flight HTTP requests.
   * Pass onProgress to receive progress updates after each chunk (multi-chunk documents).
   * Pass onCheckpoint to persist extraction state for resume capability.
   * Pass resumeCheckpoint to resume from a prior checkpoint.
   */
  async extract(
    source: IndexSource,
    signal?: AbortSignal,
    onProgress?: OnExtractionProgress,
    onCheckpoint?: OnCheckpoint,
    resumeCheckpoint?: ExtractionCheckpoint,
  ): Promise<ExtractionOutput> {
    // A rich-format source must be converted before extraction — feeding raw
    // binary bytes to an LLM produces garbage. Guard rather than silently
    // reading nonsense.
    if (source.originalFormat && !source.derivedTextPath) {
      throw new InvalidInputError(
        'source.derivedTextPath',
        `Source "${source.path}" is a ${source.originalFormat} document that has not been converted to text.`,
        'Run the convert action first so extraction reads the derived Markdown.',
      );
    }

    // Read the derived text when the source has been converted; the original
    // path otherwise.
    const documentContent = await readFile(source.derivedTextPath ?? source.path, 'utf-8');
    const systemPrompt = this.promptBuilder.buildSystemPrompt();

    let entities: ExtractedEntity[];
    let relationships: ExtractedRelationship[];
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let truncatedChunks = 0;
    let totalLLMCalls = 0;
    let entitiesSalvaged = 0;
    let relationshipsSalvaged = 0;
    let unsalvageableChunks = 0;

    const chunkSize = this.effective.maxChunkSize;
    const strategy = this.effective.chunkingStrategy;
    const useChapters = strategy === 'chapters'
      || (strategy === 'auto' && documentContent.length > chunkSize && isMarkdownStructured(documentContent));

    if (documentContent.length <= chunkSize && !useChapters) {
      // Path 1: Single-pass extraction (small documents)
      const startedAt = new Date();
      if (onProgress) {
        await this.reportProgress(onProgress, source, 1, 0, startedAt, 0, 0, 0, 0, 0, 0);
      }
      const userPrompt = this.promptBuilder.buildUserPrompt(source, documentContent);
      const result = await this.callLLM(systemPrompt, userPrompt, signal);
      entities = result.entities;
      relationships = result.relationships;
      totalLLMCalls = 1;
      if (result.usage) {
        totalPromptTokens += result.usage.prompt_tokens;
        totalCompletionTokens += result.usage.completion_tokens;
      }
      if (result.truncation) {
        truncatedChunks = 1;
        entitiesSalvaged = result.truncation.entitiesSalvaged;
        relationshipsSalvaged = result.truncation.relationshipsSalvaged;
      }
      if (onProgress) {
        await this.reportProgress(onProgress, source, 1, 1, startedAt, totalPromptTokens, totalCompletionTokens, 0, 0, entities.length, relationships.length);
      }
    } else if (useChapters) {
      // Path 2: Progressive chapter-based extraction (markdown documents)
      const result = await this.extractProgressiveChapters(source, documentContent, systemPrompt, signal, onProgress, onCheckpoint, resumeCheckpoint);
      entities = result.entities;
      relationships = result.relationships;
      totalPromptTokens = result.promptTokens;
      totalCompletionTokens = result.completionTokens;
      truncatedChunks = result.truncatedChunks;
      totalLLMCalls = result.totalLLMCalls;
      entitiesSalvaged = result.entitiesSalvaged;
      relationshipsSalvaged = result.relationshipsSalvaged;
      unsalvageableChunks = result.unsalvageableChunks;
    } else {
      // Path 3: Fixed-size chunking fallback (non-markdown large documents)
      const chunks = splitIntoChunks(documentContent, chunkSize, CHUNK_OVERLAP);
      entities = [];
      relationships = [];

      totalLLMCalls = chunks.length;
      for (let i = 0; i < chunks.length; i++) {
        if (signal?.aborted) {
          throw new Error('Extraction cancelled');
        }

        const chunk = chunks[i]!;
        const userPrompt = this.promptBuilder.buildChunkPrompt(
          source,
          chunk.content,
          i,
          chunks.length,
          chunk.lineOffset,
        );
        const result = await this.callLLM(systemPrompt, userPrompt, signal);
        entities.push(...result.entities);
        relationships.push(...result.relationships);
        if (result.usage) {
          totalPromptTokens += result.usage.prompt_tokens;
          totalCompletionTokens += result.usage.completion_tokens;
        }
        if (result.truncation) {
          truncatedChunks++;
          entitiesSalvaged += result.truncation.entitiesSalvaged;
          relationshipsSalvaged += result.truncation.relationshipsSalvaged;
        }
      }

      entities = deduplicateEntities(entities);
      relationships = deduplicateRelationships(relationships);
    }

    return {
      source: basename(source.path),
      sourcePath: source.path,
      extractedAt: new Date().toISOString(),
      extractedBy: `extraction-worker:${this.effective.model}`,
      entities,
      relationships,
      usage: totalPromptTokens > 0 ? { inputTokens: totalPromptTokens, outputTokens: totalCompletionTokens } : undefined,
      truncation: truncatedChunks > 0 || unsalvageableChunks > 0 ? {
        truncatedChunks,
        totalChunks: totalLLMCalls,
        entitiesSalvaged,
        relationshipsSalvaged,
        unsalvageableChunks,
      } : undefined,
    };
  }

  /**
   * Extract a single chapter, retrying with sub-splitting on truncation.
   *
   * If the LLM output is truncated (finish_reason: 'length') and JSON repair
   * salvages partial results, those are used. If repair fails, the chapter is
   * split in half and each half is extracted independently.
   *
   * Max recursion depth of 3 prevents infinite splitting (minimum ~1/8 of
   * original chunk size).
   */
  private async extractChapterWithRetry(
    source: IndexSource,
    chapter: Chapter,
    chapterIndex: number,
    totalChapters: number,
    overview: DocumentOverview,
    context: ProgressiveContext,
    systemPrompt: string,
    signal?: AbortSignal,
    depth: number = 0,
  ): Promise<{
    entities: ExtractedEntity[];
    relationships: ExtractedRelationship[];
    promptTokens: number;
    completionTokens: number;
    throttleRetries: number;
    throttleBackoffMs: number;
    truncationEvents: number;
    entitiesSalvaged: number;
    relationshipsSalvaged: number;
    unsalvageableChunks: number;
  }> {
    const numberedContent = addChapterLineNumbers(chapter);
    const userPrompt = this.promptBuilder.buildChapterPrompt(
      source,
      numberedContent,
      chapterIndex,
      totalChapters,
      overview,
      context.toPromptSection(chapterIndex),
    );

    try {
      const result = await this.callLLM(systemPrompt, userPrompt, signal);
      return {
        entities: result.entities,
        relationships: result.relationships,
        promptTokens: result.usage?.prompt_tokens ?? 0,
        completionTokens: result.usage?.completion_tokens ?? 0,
        throttleRetries: result.throttle?.retries ?? 0,
        throttleBackoffMs: result.throttle?.totalBackoffMs ?? 0,
        truncationEvents: result.truncation ? 1 : 0,
        entitiesSalvaged: result.truncation?.entitiesSalvaged ?? 0,
        relationshipsSalvaged: result.truncation?.relationshipsSalvaged ?? 0,
        unsalvageableChunks: 0,
      };
    } catch (error) {
      if (!(error instanceof OutputTruncatedError)) throw error;

      // Truncation with no salvageable data — sub-split and retry
      if (depth >= 3) {
        // Max depth reached — give up on this chapter
        throw new Error(
          `Chapter ${chapterIndex + 1} still truncating after ${depth} sub-splits ` +
          `(chunk size ~${chapter.content.length} chars). ` +
          `Consider increasing maxOutputTokens or reducing maxChunkSize.`,
        );
      }

      // Split the chapter in half at a line boundary
      const lines = chapter.content.split('\n');
      const midpoint = Math.floor(lines.length / 2);

      const firstHalf: Chapter = {
        index: chapter.index,
        heading: chapter.heading,
        headingLevel: chapter.headingLevel,
        content: lines.slice(0, midpoint).join('\n'),
        lineStart: chapter.lineStart,
        lineEnd: chapter.lineStart + midpoint - 1,
      };
      const secondHalf: Chapter = {
        index: chapter.index,
        heading: `${chapter.heading} (continued)`,
        headingLevel: chapter.headingLevel,
        content: lines.slice(midpoint).join('\n'),
        lineStart: chapter.lineStart + midpoint,
        lineEnd: chapter.lineEnd,
      };

      // Extract both halves recursively
      const firstResult = await this.extractChapterWithRetry(
        source, firstHalf, chapterIndex, totalChapters, overview, context,
        systemPrompt, signal, depth + 1,
      );

      // Feed first half results into context so second half can reference them
      context.addChapterResults(chapterIndex, firstResult.entities, firstResult.relationships);

      const secondResult = await this.extractChapterWithRetry(
        source, secondHalf, chapterIndex, totalChapters, overview, context,
        systemPrompt, signal, depth + 1,
      );

      return {
        entities: [...firstResult.entities, ...secondResult.entities],
        relationships: [...firstResult.relationships, ...secondResult.relationships],
        promptTokens: firstResult.promptTokens + secondResult.promptTokens,
        completionTokens: firstResult.completionTokens + secondResult.completionTokens,
        throttleRetries: firstResult.throttleRetries + secondResult.throttleRetries,
        throttleBackoffMs: firstResult.throttleBackoffMs + secondResult.throttleBackoffMs,
        truncationEvents: firstResult.truncationEvents + secondResult.truncationEvents,
        entitiesSalvaged: firstResult.entitiesSalvaged + secondResult.entitiesSalvaged,
        relationshipsSalvaged: firstResult.relationshipsSalvaged + secondResult.relationshipsSalvaged,
        unsalvageableChunks: 1 + firstResult.unsalvageableChunks + secondResult.unsalvageableChunks,
      };
    }
  }

  /**
   * Call the LLM via the configured provider and parse the extraction response.
   */
  private async callLLM(
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal,
  ): Promise<{ entities: ExtractedEntity[]; relationships: ExtractedRelationship[]; usage?: { prompt_tokens: number; completion_tokens: number; cache_read_tokens?: number; cache_creation_tokens?: number }; throttle?: { retries: number; totalBackoffMs: number }; truncation?: { wasTruncated: boolean; entitiesSalvaged: number; relationshipsSalvaged: number } }> {
    const callId = ++this.callSequence;
    const startTime = Date.now();

    // Log request
    await this.writeLog(callId, 'request', {
      worker: this.effective.workerName,
      provider: this.llmProvider.name,
      model: this.effective.model,
      maxTokens: this.effective.maxTokens,
      temperature: this.effective.temperature,
      systemPromptLength: systemPrompt.length,
      userPromptLength: userPrompt.length,
      systemPrompt,
      userPrompt,
    });

    let responseContent: string | undefined;
    let responseUsage: { prompt_tokens: number; completion_tokens: number; cache_read_tokens?: number; cache_creation_tokens?: number } | undefined;
    let responseThrottle: { retries: number; totalBackoffMs: number } | undefined;

    try {
      // Delegate transport to provider
      const result = await this.llmProvider.chatCompletion(
        systemPrompt,
        userPrompt,
        {
          model: this.effective.model,
          temperature: this.effective.temperature,
          maxTokens: this.effective.maxTokens,
          extraBodyParams: this.effective.extraBodyParams,
        },
        signal,
      );

      responseContent = result.content;
      responseUsage = result.usage;
      responseThrottle = result.throttle;

      // Detect output truncation — finish_reason 'length' means the model
      // hit maxOutputTokens before completing the response
      if (result.finish_reason === 'length') {
        await this.writeLog(callId, 'truncation', {
          durationMs: Date.now() - startTime,
          finishReason: result.finish_reason,
          usage: responseUsage,
          responseLength: responseContent.length,
          rawResponse: responseContent,
          cacheReadTokens: responseUsage?.cache_read_tokens,
          cacheCreationTokens: responseUsage?.cache_creation_tokens,
        });

        // Try to salvage partial results from truncated JSON
        const salvaged = repairTruncatedJSON(responseContent);
        if (salvaged) {
          await this.writeLog(callId, 'truncation-salvaged', {
            entitiesSalvaged: salvaged.entities.length,
            relationshipsSalvaged: salvaged.relationships.length,
          });
          return {
            ...salvaged,
            usage: responseUsage,
            truncation: {
              wasTruncated: true,
              entitiesSalvaged: salvaged.entities.length,
              relationshipsSalvaged: salvaged.relationships.length,
            },
          };
        }

        throw new OutputTruncatedError(
          `LLM output truncated (finish_reason: length). Response length: ${responseContent.length} chars. ` +
          `Usage: ${responseUsage?.completion_tokens ?? '?'} output tokens. ` +
          `The chunk likely produces more entities than maxOutputTokens allows.`,
          responseContent,
          responseUsage,
        );
      }

      const parsed = parseExtractionResponse(responseContent);

      // Log successful response
      await this.writeLog(callId, 'response', {
        worker: this.effective.workerName,
        durationMs: Date.now() - startTime,
        finishReason: result.finish_reason,
        usage: responseUsage,
        responseLength: responseContent.length,
        entitiesExtracted: parsed.entities.length,
        relationshipsExtracted: parsed.relationships.length,
        rawResponse: responseContent,
        cacheReadTokens: responseUsage?.cache_read_tokens,
        cacheCreationTokens: responseUsage?.cache_creation_tokens,
        ...(responseThrottle ? { throttle: responseThrottle } : {}),
      });

      return {
        ...parsed,
        usage: responseUsage,
        throttle: responseThrottle,
      };
    } catch (error) {
      // Log parse/transport failures with the raw response when available
      if (responseContent) {
        await this.writeLog(callId, 'parse-error', {
          durationMs: Date.now() - startTime,
          usage: responseUsage,
          responseLength: responseContent.length,
          error: error instanceof Error ? error.message : String(error),
          rawResponse: responseContent,
        });
      } else {
        await this.writeLog(callId, 'error', {
          durationMs: Date.now() - startTime,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  /**
   * Write a log entry to the log directory if configured.
   */
  private async writeLog(callId: number, phase: string, data: Record<string, unknown>): Promise<void> {
    if (!this.effective.logDir) return;

    try {
      await mkdir(this.effective.logDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${timestamp}_extraction-call-${String(callId).padStart(3, '0')}_${phase}.json`;
      const logPath = join(this.effective.logDir, filename);
      await writeFile(logPath, JSON.stringify(data, null, 2) + '\n');
    } catch {
      // Logging should never break extraction
    }
  }

  /**
   * Progressive extraction with smart document splitting.
   *
   * Splits the document at natural boundaries (headings, page markers,
   * paragraph gaps), then processes each segment sequentially. Each segment
   * receives the document overview and a cumulative context of entities/
   * relationships extracted from prior segments, so the model can reference
   * existing entities by their canonical labels.
   */
  private async extractProgressiveChapters(
    source: IndexSource,
    documentContent: string,
    systemPrompt: string,
    signal?: AbortSignal,
    onProgress?: OnExtractionProgress,
    onCheckpoint?: OnCheckpoint,
    resumeCheckpoint?: ExtractionCheckpoint,
  ): Promise<{
    entities: ExtractedEntity[];
    relationships: ExtractedRelationship[];
    promptTokens: number;
    completionTokens: number;
    truncatedChunks: number;
    totalLLMCalls: number;
    entitiesSalvaged: number;
    relationshipsSalvaged: number;
    unsalvageableChunks: number;
  }> {
    const chunkSize = this.effective.maxChunkSize;
    const chapters = splitIntoChapters(documentContent, chunkSize);
    const overview = generateOverview(source, chapters);

    let allEntities: ExtractedEntity[] = [];
    let allRelationships: ExtractedRelationship[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let startChapterIndex = 0;
    let context: ProgressiveContext;

    // Resume from checkpoint if available and valid
    if (resumeCheckpoint && this.isCheckpointValid(resumeCheckpoint, source, chapters.length)) {
      allEntities = resumeCheckpoint.entities;
      allRelationships = resumeCheckpoint.relationships;
      promptTokens = resumeCheckpoint.tokensUsed.inputTokens;
      completionTokens = resumeCheckpoint.tokensUsed.outputTokens;
      startChapterIndex = resumeCheckpoint.completedChunks;
      context = ProgressiveContext.fromJSON(resumeCheckpoint.progressiveContext);
    } else {
      context = new ProgressiveContext(this.effective.progressiveContextWindow);
    }

    const startedAt = new Date();
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let throttleRetries = 0;
    let throttleBackoffMs = 0;
    let truncatedChunks = 0;
    let totalLLMCalls = 0;
    let entitiesSalvaged = 0;
    let relationshipsSalvaged = 0;
    let unsalvageableChunks = 0;

    // Report initial progress
    if (onProgress) {
      await this.reportProgress(onProgress, source, chapters.length, startChapterIndex, startedAt, promptTokens, completionTokens, cacheReadTokens, cacheCreationTokens, allEntities.length, allRelationships.length, throttleRetries, throttleBackoffMs);
    }

    for (let i = startChapterIndex; i < chapters.length; i++) {
      if (signal?.aborted) throw new Error('Extraction cancelled');

      const chapter = chapters[i]!;

      // Skip empty or near-empty segments
      if (chapter.content.trim().length < 50) continue;

      const chapterResult = await this.extractChapterWithRetry(
        source, chapter, i, chapters.length, overview, context, systemPrompt, signal,
      );

      allEntities.push(...chapterResult.entities);
      allRelationships.push(...chapterResult.relationships);
      promptTokens += chapterResult.promptTokens;
      completionTokens += chapterResult.completionTokens;
      throttleRetries += chapterResult.throttleRetries;
      throttleBackoffMs += chapterResult.throttleBackoffMs;
      totalLLMCalls++;
      truncatedChunks += chapterResult.truncationEvents;
      entitiesSalvaged += chapterResult.entitiesSalvaged;
      relationshipsSalvaged += chapterResult.relationshipsSalvaged;
      unsalvageableChunks += chapterResult.unsalvageableChunks;

      // Feed results into progressive context for subsequent segments
      context.addChapterResults(i, chapterResult.entities, chapterResult.relationships);

      // Write checkpoint after each chunk
      if (onCheckpoint) {
        await this.writeCheckpoint(onCheckpoint, source, chapters.length, i + 1, allEntities, allRelationships, context, promptTokens, completionTokens);
      }

      // Report progress after each chunk
      if (onProgress) {
        await this.reportProgress(onProgress, source, chapters.length, i + 1, startedAt, promptTokens, completionTokens, cacheReadTokens, cacheCreationTokens, allEntities.length, allRelationships.length, throttleRetries, throttleBackoffMs);
      }
    }

    // Final deduplication across all segments
    allEntities = deduplicateEntities(allEntities);
    allRelationships = deduplicateRelationships(allRelationships);

    return { entities: allEntities, relationships: allRelationships, promptTokens, completionTokens, truncatedChunks, totalLLMCalls, entitiesSalvaged, relationshipsSalvaged, unsalvageableChunks };
  }

  /** Validate that a checkpoint matches the current extraction parameters */
  private isCheckpointValid(
    checkpoint: ExtractionCheckpoint,
    source: IndexSource,
    totalChunks: number,
  ): boolean {
    return (
      checkpoint.sourcePath === source.path &&
      checkpoint.model === this.effective.model &&
      checkpoint.totalChunks === totalChunks &&
      checkpoint.completedChunks > 0 &&
      checkpoint.completedChunks < totalChunks
    );
  }

  /** Write checkpoint data after a completed chunk */
  private async writeCheckpoint(
    onCheckpoint: OnCheckpoint,
    source: IndexSource,
    totalChunks: number,
    completedChunks: number,
    entities: ExtractedEntity[],
    relationships: ExtractedRelationship[],
    context: ProgressiveContext,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    const checkpoint: ExtractionCheckpoint = {
      source: basename(source.path),
      sourcePath: source.path,
      model: this.effective.model,
      chunkingStrategy: this.effective.chunkingStrategy,
      totalChunks,
      completedChunks,
      entities,
      relationships,
      progressiveContext: context.toJSON(),
      tokensUsed: { inputTokens, outputTokens },
      lastUpdated: new Date().toISOString(),
    };

    try {
      await onCheckpoint(checkpoint);
    } catch {
      // Checkpoint writing should never break extraction
    }
  }

  /** Build and emit an ExtractionProgress update */
  private async reportProgress(
    onProgress: OnExtractionProgress,
    source: IndexSource,
    totalChunks: number,
    completedChunks: number,
    startedAt: Date,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheCreationTokens: number,
    entitiesSoFar: number,
    relationshipsSoFar: number,
    throttleRetries: number = 0,
    throttleBackoffMs: number = 0,
  ): Promise<void> {
    const now = Date.now();
    const elapsedMs = now - startedAt.getTime();
    const avgChunkMs = completedChunks > 0 ? Math.round(elapsedMs / completedChunks) : undefined;
    const remainingChunks = totalChunks - completedChunks;
    const estimatedRemainingMs = avgChunkMs && remainingChunks > 0 ? avgChunkMs * remainingChunks : undefined;

    const progress: ExtractionProgress = {
      source: basename(source.path),
      sourcePath: source.path,
      assignedWorker: source.assignedWorkers?.[0],
      totalChunks,
      completedChunks,
      startedAt: startedAt.toISOString(),
      lastChunkAt: completedChunks > 0 ? new Date().toISOString() : undefined,
      elapsedMs,
      avgChunkMs,
      estimatedRemainingMs,
      tokensUsed: {
        inputTokens,
        outputTokens,
        cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
        cacheCreationTokens: cacheCreationTokens > 0 ? cacheCreationTokens : undefined,
      },
      entitiesSoFar,
      relationshipsSoFar,
      throttle: throttleRetries > 0 ? {
        totalRetries: throttleRetries,
        totalBackoffMs: throttleBackoffMs,
        lastThrottledAt: new Date().toISOString(),
      } : undefined,
    };

    try {
      await onProgress(progress);
    } catch {
      // Progress reporting should never break extraction
    }
  }
}

// ── Response Parsing ────────────────────────────────────────────────

/** Parse the LLM response into structured extraction data */
function parseExtractionResponse(
  content: string,
): { entities: ExtractedEntity[]; relationships: ExtractedRelationship[] } {
  // Strip thinking tags (e.g., Qwen3 thinking models wrap output in <think>...</think>)
  let json = content.trim();
  json = json.replace(/^<think>[\s\S]*?<\/think>\s*/i, '');

  // Strip markdown code fences if present
  json = json.trim();
  if (json.startsWith('```')) {
    json = json.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`Failed to parse LLM response as JSON: ${e instanceof Error ? e.message : String(e)}\nResponse: ${content.slice(0, 500)}`);
  }

  if (!isExtractionResult(parsed)) {
    throw new Error(`LLM response does not match expected format. Got keys: ${Object.keys(parsed as Record<string, unknown>).join(', ')}`);
  }

  return {
    entities: parsed.entities.map(normalizeEntity),
    relationships: parsed.relationships.map(normalizeRelationship),
  };
}

function normalizeEntity(raw: Record<string, unknown>): ExtractedEntity {
  return {
    entityType: String(raw['entityType'] ?? ''),
    label: String(raw['label'] ?? ''),
    summary: raw['summary'] != null ? String(raw['summary']) : undefined,
    properties: (raw['properties'] as Record<string, unknown>) ?? {},
    aliases: Array.isArray(raw['aliases']) ? raw['aliases'].map(String) : [],
    sourceRefs: Array.isArray(raw['sourceRefs'])
      ? raw['sourceRefs'].map((ref: Record<string, unknown>) => ({
          description: String(ref['description'] ?? ''),
          lineStart: Number(ref['lineStart'] ?? 0),
          lineEnd: Number(ref['lineEnd'] ?? 0),
        }))
      : [],
  };
}

function normalizeRelationship(raw: Record<string, unknown>): ExtractedRelationship {
  return {
    type: String(raw['type'] ?? ''),
    sourceLabel: String(raw['sourceLabel'] ?? ''),
    targetLabel: String(raw['targetLabel'] ?? ''),
    properties: (raw['properties'] as Record<string, unknown>) ?? {},
    sourceRefs: Array.isArray(raw['sourceRefs'])
      ? raw['sourceRefs'].map((ref: Record<string, unknown>) => ({
          description: String(ref['description'] ?? ''),
          lineStart: Number(ref['lineStart'] ?? 0),
          lineEnd: Number(ref['lineEnd'] ?? 0),
        }))
      : [],
  };
}

/**
 * Attempt to repair truncated JSON from an LLM response.
 *
 * Strategy: find the last complete entity or relationship object in the
 * truncated JSON, then close all open brackets/braces to make it parseable.
 * Returns null if repair fails or yields no useful data.
 */
function repairTruncatedJSON(
  content: string,
): { entities: ExtractedEntity[]; relationships: ExtractedRelationship[] } | null {
  let json = content.trim();
  // Strip thinking tags and code fences
  json = json.replace(/^<think>[\s\S]*?<\/think>\s*/i, '');
  json = json.trim();
  if (json.startsWith('```')) {
    json = json.replace(/^```(?:json)?\s*/, '');
  }

  // Find the last complete object boundary — look for the last '}' that
  // is followed by a comma or is at the end of an array element
  // Strategy: progressively truncate from the end, trying to close the JSON
  // by finding the last complete array element

  // First, try to find where we are in the structure
  // Look for the last complete "}" that ends a full entity/relationship object
  let lastGoodPos = -1;
  let braceDepth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < json.length; i++) {
    const ch = json[i]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') {
      braceDepth++;
    } else if (ch === '}') {
      braceDepth--;
      // At depth 1, we just closed an entity/relationship object
      if (braceDepth === 1) {
        lastGoodPos = i;
      }
    }
  }

  if (lastGoodPos <= 0) return null;

  // Truncate after the last complete object
  let repaired = json.slice(0, lastGoodPos + 1);

  // Close any open structures
  // We need to figure out if we were in "entities" or "relationships" array
  const hasRelationships = repaired.includes('"relationships"');

  if (hasRelationships) {
    // We might be mid-relationships array
    repaired += ']}';
  } else {
    // Still in entities array — close entities and add empty relationships
    repaired += '], "relationships": []}';
  }

  try {
    const parsed = JSON.parse(repaired);
    if (!isExtractionResult(parsed)) return null;
    // Only return if we actually got some data
    if (parsed.entities.length === 0 && parsed.relationships.length === 0) return null;
    return {
      entities: parsed.entities.map(normalizeEntity),
      relationships: parsed.relationships.map(normalizeRelationship),
    };
  } catch {
    return null;
  }
}

function isExtractionResult(value: unknown): value is { entities: Record<string, unknown>[]; relationships: Record<string, unknown>[] } {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj['entities']) && Array.isArray(obj['relationships']);
}

// ── Document Chunking ───────────────────────────────────────────────

interface Chunk {
  content: string;
  lineOffset: number;
}

/** Split a document into overlapping chunks, preferring to break at line boundaries */
function splitIntoChunks(content: string, maxChars: number, overlap: number): Chunk[] {
  const lines = content.split('\n');
  const chunks: Chunk[] = [];
  let currentLines: string[] = [];
  let currentChars = 0;
  let chunkStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineChars = line.length + 1; // +1 for newline

    if (currentChars + lineChars > maxChars && currentLines.length > 0) {
      // Emit current chunk
      chunks.push({
        content: addLineNumbers(currentLines, chunkStartLine),
        lineOffset: chunkStartLine,
      });

      // Calculate overlap: walk backwards to find overlap boundary
      let overlapChars = 0;
      let overlapStart = currentLines.length;
      while (overlapStart > 0 && overlapChars < overlap) {
        overlapStart--;
        overlapChars += (currentLines[overlapStart]?.length ?? 0) + 1;
      }

      // Start new chunk with overlap
      chunkStartLine = chunkStartLine + overlapStart;
      currentLines = currentLines.slice(overlapStart);
      currentChars = currentLines.reduce((sum, l) => sum + l.length + 1, 0);
    }

    currentLines.push(line);
    currentChars += lineChars;
  }

  // Emit final chunk
  if (currentLines.length > 0) {
    chunks.push({
      content: addLineNumbers(currentLines, chunkStartLine),
      lineOffset: chunkStartLine,
    });
  }

  return chunks;
}

/** Add line numbers to an array of lines, starting from a given offset */
function addLineNumbers(lines: string[], offset: number): string {
  return lines.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');
}

// ── Intra-Document Deduplication ────────────────────────────────────

/** Deduplicate entities within a single document extraction (from chunked processing) */
function deduplicateEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
  const seen = new Map<string, ExtractedEntity>();

  for (const entity of entities) {
    const key = `${entity.entityType}:${entity.label.toLowerCase()}`;
    const existing = seen.get(key);

    if (existing) {
      // Merge: keep the richer version, combine sourceRefs and aliases
      existing.sourceRefs.push(...entity.sourceRefs);
      for (const alias of entity.aliases) {
        if (!existing.aliases.includes(alias)) {
          existing.aliases.push(alias);
        }
      }
      // Merge properties (existing wins on conflicts)
      existing.properties = { ...entity.properties, ...existing.properties };
      // Keep longer summary
      if (entity.summary && (!existing.summary || entity.summary.length > existing.summary.length)) {
        existing.summary = entity.summary;
      }
    } else {
      seen.set(key, { ...entity });
    }
  }

  return [...seen.values()];
}

/** Deduplicate relationships within a single document extraction */
function deduplicateRelationships(relationships: ExtractedRelationship[]): ExtractedRelationship[] {
  const seen = new Map<string, ExtractedRelationship>();

  for (const rel of relationships) {
    const key = `${rel.type}:${rel.sourceLabel.toLowerCase()}:${rel.targetLabel.toLowerCase()}`;
    const existing = seen.get(key);

    if (existing) {
      existing.sourceRefs.push(...rel.sourceRefs);
      existing.properties = { ...rel.properties, ...existing.properties };
    } else {
      seen.set(key, { ...rel });
    }
  }

  return [...seen.values()];
}

