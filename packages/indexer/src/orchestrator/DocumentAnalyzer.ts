import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { WorkerConfig, WorkerCapability, ExtractionConfig } from '../types/config.js';
import type { IndexSource, DocumentTokenEstimate } from '../types/source-list.js';
import { isMarkdownStructured, splitIntoChapters } from '../extraction/ChapterSplitter.js';
import type { FullValidationConfig, ValidationCostEstimate } from '../validation/full-validation-types.js';

/** Default characters-to-tokens ratio for English text */
const DEFAULT_CHARS_PER_TOKEN = 4;

/** Estimated prompt overhead in tokens (vocabulary + system prompt + extraction rules) */
const DEFAULT_PROMPT_OVERHEAD_TOKENS = 2000;

/**
 * Output density by document type — ratio of estimated output tokens to input tokens.
 * Spec sheets with dense tables produce more structured output per token of input
 * than narrative prose.
 */
const OUTPUT_DENSITY_BY_TYPE: Record<string, number> = {
  'spec-sheet': 0.6,
  'om-manual': 0.3,
  'performance-handbook': 0.4,
  'troubleshooting': 0.35,
  'parts-catalog': 0.5,
  'general': 0.4,
};

/** Document type to required capabilities mapping */
const CAPABILITIES_BY_TYPE: Record<string, WorkerCapability[]> = {
  'spec-sheet': ['structured-extraction'],
  'om-manual': ['prose-extraction'],
  'performance-handbook': ['prose-extraction'],
  'troubleshooting': ['prose-extraction'],
  'parts-catalog': ['structured-extraction'],
  'general': ['structured-extraction'],
};

/** Analysis result for a single document */
export interface DocumentAnalysis {
  source: string;
  path: string;
  type: string;
  sizeBytes: number;
  sizeKB: number;
  estimatedDocumentTokens: number;
  assignedWorkers: string[];
  estimatedTokens: DocumentTokenEstimate;
  estimatedCost: number;
  /** Whether token values come from actual prior extraction rather than estimates */
  usedActuals: boolean;
  /** Actual chunk count from dry-run chapter splitting (null if not markdown or single-chunk) */
  actualChunks?: number;
  note?: string;
}

/** Per-worker summary in the analysis report */
export interface WorkerAnalysisSummary {
  documents: number;
  inputTokens: number;
  outputTokens: number;
  chunks: number;
  cost: number;
}

/** Full analysis report */
export interface AnalysisReport {
  summary: {
    totalDocuments: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    estimatedCost: string;
    unassignedDocuments: number;
  };
  byWorker: Record<string, WorkerAnalysisSummary>;
  documents: DocumentAnalysis[];
  /** Full extraction validation cost estimate (present when fullValidation config is set and extraction data is available) */
  validationEstimate?: ValidationCostEstimate;
}

/**
 * Analyzes source documents and assigns them to workers based on size,
 * capabilities, and cost. Pure calculation — no LLM calls.
 */
export class DocumentAnalyzer {
  private readonly workers: WorkerConfig[];
  private readonly promptOverheadTokens: number;
  private readonly charsPerToken: number;
  private readonly outputDensityOverrides: Record<string, number>;

  constructor(options: {
    workers: WorkerConfig[];
    promptOverheadTokens?: number;
    charsPerToken?: number;
    outputDensityOverrides?: Record<string, number>;
  }) {
    this.workers = options.workers;
    this.promptOverheadTokens = options.promptOverheadTokens ?? DEFAULT_PROMPT_OVERHEAD_TOKENS;
    this.charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
    this.outputDensityOverrides = options.outputDensityOverrides ?? {};
  }

  /**
   * Create a DocumentAnalyzer from an ExtractionConfig.
   * If the config has no worker pool, synthesizes a single worker from
   * the top-level extraction fields.
   */
  static fromExtractionConfig(config: ExtractionConfig): DocumentAnalyzer {
    const workers = config.workers ?? [singleWorkerFromConfig(config)];
    return new DocumentAnalyzer({ workers });
  }

  /**
   * Analyze all pending sources: estimate tokens, assign workers, calculate costs.
   */
  async analyze(sources: IndexSource[]): Promise<AnalysisReport> {
    const documents: DocumentAnalysis[] = [];

    for (const source of sources) {
      const analysis = await this.analyzeDocument(source);
      documents.push(analysis);
    }

    // Build per-worker summaries
    const byWorker: Record<string, WorkerAnalysisSummary> = {};
    for (const worker of this.workers) {
      byWorker[worker.name] = { documents: 0, inputTokens: 0, outputTokens: 0, chunks: 0, cost: 0 };
    }

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;
    let unassignedDocuments = 0;

    for (const doc of documents) {
      totalInputTokens += doc.estimatedTokens.inputTokens;
      totalOutputTokens += doc.estimatedTokens.outputTokens;
      totalCost += doc.estimatedCost;

      if (doc.assignedWorkers.length > 0) {
        for (const wName of doc.assignedWorkers) {
          const ws = byWorker[wName];
          if (ws) {
            ws.documents++;
            ws.inputTokens += doc.estimatedTokens.inputTokens;
            ws.outputTokens += doc.estimatedTokens.outputTokens;
            ws.chunks += doc.estimatedTokens.chunks;
            ws.cost += doc.estimatedCost;
          }
        }
      } else {
        unassignedDocuments++;
      }
    }

    return {
      summary: {
        totalDocuments: documents.length,
        totalInputTokens,
        totalOutputTokens,
        estimatedCost: `$${totalCost.toFixed(2)}`,
        unassignedDocuments,
      },
      byWorker,
      documents,
    };
  }

  /**
   * Assign a single source to the best worker.
   * Returns the worker name or null if no worker can handle the document.
   */
  assignWorker(source: IndexSource, documentTokens: number): string | null {
    const requiredCapabilities = CAPABILITIES_BY_TYPE[source.type] ?? CAPABILITIES_BY_TYPE['general']!;
    const needsLargeContext = documentTokens > 8000; // >32K chars roughly

    const scored = this.workers
      .filter(w => {
        // Must have all required capabilities
        for (const cap of requiredCapabilities) {
          if (!w.capabilities.includes(cap)) return false;
        }
        // Must have large-context if needed
        if (needsLargeContext && !w.capabilities.includes('large-context')) {
          // Check if the document fits within this worker's context window anyway
          const availableTokens = w.contextWindow - this.promptOverheadTokens - w.maxOutputTokens;
          if (documentTokens > availableTokens) return false;
        }
        return true;
      })
      .map(w => {
        const availableTokens = w.contextWindow - this.promptOverheadTokens - w.maxOutputTokens;
        const chunks = Math.max(1, Math.ceil(documentTokens / Math.max(1, availableTokens)));
        const costPerToken = w.costPerMillionInputTokens + w.costPerMillionOutputTokens;
        return { worker: w, chunks, costPerToken };
      })
      // Prefer fewest chunks, then cheapest
      .sort((a, b) => {
        if (a.chunks !== b.chunks) return a.chunks - b.chunks;
        return a.costPerToken - b.costPerToken;
      });

    return scored[0]?.worker.name ?? null;
  }

  /**
   * Analyze a single document: estimate size, assign worker, calculate cost.
   */
  private async analyzeDocument(source: IndexSource): Promise<DocumentAnalysis> {
    // Sources awaiting conversion have no readable text yet — reading the raw
    // binary as UTF-8 would ingest garbage and produce a meaningless estimate.
    // Report them as pending conversion instead.
    if (source.status === 'needs-conversion' || source.status === 'converting') {
      let sizeBytes = 0;
      try {
        sizeBytes = (await stat(source.path)).size;
      } catch {
        const match = source.notes?.match(/(\d+)\s*KB/);
        sizeBytes = match ? parseInt(match[1]!, 10) * 1024 : 0;
      }
      return {
        source: basename(source.path),
        path: source.path,
        type: source.type,
        sizeBytes,
        sizeKB: Math.round(sizeBytes / 1024),
        estimatedDocumentTokens: 0,
        assignedWorkers: [],
        estimatedTokens: { inputTokens: 0, outputTokens: 0, chunks: 0 },
        estimatedCost: 0,
        usedActuals: false,
        note: 'Awaiting conversion — run the convert action before extraction to estimate this source.',
      };
    }

    // Read the derived text when a source has been converted; the original
    // path otherwise.
    const readPath = source.derivedTextPath ?? source.path;
    let sizeBytes: number;
    let documentContent: string | null = null;
    try {
      const stats = await stat(readPath);
      sizeBytes = stats.size;
      documentContent = await readFile(readPath, 'utf-8');
    } catch {
      // File may not exist yet (e.g., test scenario); use notes field if available
      const match = source.notes?.match(/(\d+)\s*KB/);
      sizeBytes = match ? parseInt(match[1]!, 10) * 1024 : 0;
    }

    const sizeKB = Math.round(sizeBytes / 1024);
    const documentTokens = Math.ceil(sizeBytes / this.charsPerToken);
    const outputDensity = this.outputDensityOverrides[source.type]
      ?? OUTPUT_DENSITY_BY_TYPE[source.type]
      ?? OUTPUT_DENSITY_BY_TYPE['general']!;

    // Use pre-assigned workers if set, otherwise assign one
    const assignedWorkers = source.assignedWorkers ?? [];
    const primaryWorkerName = assignedWorkers[0] ?? this.assignWorker(source, documentTokens);
    const worker = primaryWorkerName ? this.workers.find(w => w.name === primaryWorkerName) : null;
    const resolvedWorkers = assignedWorkers.length > 0 ? assignedWorkers : (primaryWorkerName ? [primaryWorkerName] : []);

    let estimatedTokens: DocumentTokenEstimate;
    let estimatedCost: number;
    let note: string | undefined;
    let usedActuals = false;

    // If we have actual tokens from a prior extraction, use those instead of estimating
    if (source.actualTokens) {
      const actualChunks = source.estimatedTokens?.chunks ?? 1;
      estimatedTokens = {
        inputTokens: source.actualTokens.inputTokens,
        outputTokens: source.actualTokens.outputTokens,
        chunks: actualChunks,
      };
      usedActuals = true;

      if (worker) {
        estimatedCost =
          (source.actualTokens.inputTokens / 1_000_000) * worker.costPerMillionInputTokens +
          (source.actualTokens.outputTokens / 1_000_000) * worker.costPerMillionOutputTokens;
      } else {
        estimatedCost = 0;
      }
      note = 'Cost based on actual token usage from prior extraction';
    } else if (worker) {
      const availableTokens = worker.contextWindow - this.promptOverheadTokens - worker.maxOutputTokens;
      const chunks = Math.max(1, Math.ceil(documentTokens / Math.max(1, availableTokens)));
      const inputPerChunk = Math.min(documentTokens, availableTokens);
      const totalInputTokens = chunks * (this.promptOverheadTokens + inputPerChunk);
      const totalOutputTokens = Math.ceil(chunks * inputPerChunk * outputDensity);

      estimatedTokens = {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        chunks,
      };

      estimatedCost =
        (totalInputTokens / 1_000_000) * worker.costPerMillionInputTokens +
        (totalOutputTokens / 1_000_000) * worker.costPerMillionOutputTokens;

      if (chunks > 1) {
        note = `Requires ${chunks} chunks on ${worker.name}`;
      }
    } else {
      estimatedTokens = { inputTokens: documentTokens, outputTokens: 0, chunks: 0 };
      estimatedCost = 0;
      note = 'No worker can handle this document — requires manual assignment or a more capable worker';
    }

    // Dry-run chapter splitting for accurate chunk count (no LLM calls, pure string processing)
    let actualChunks: number | undefined;
    if (documentContent && worker) {
      const maxChunkSize = worker.maxChunkSize;
      if (documentContent.length > maxChunkSize && isMarkdownStructured(documentContent)) {
        const chapters = splitIntoChapters(documentContent, maxChunkSize);
        actualChunks = chapters.length;
        // Update the estimated chunks if the actual count differs
        if (actualChunks !== estimatedTokens.chunks) {
          const ratio = actualChunks / Math.max(1, estimatedTokens.chunks);
          estimatedTokens = {
            ...estimatedTokens,
            chunks: actualChunks,
            inputTokens: Math.ceil(estimatedTokens.inputTokens * ratio),
            outputTokens: Math.ceil(estimatedTokens.outputTokens * ratio),
          };
          // Recalculate cost with updated token estimates
          if (!usedActuals) {
            estimatedCost =
              (estimatedTokens.inputTokens / 1_000_000) * worker.costPerMillionInputTokens +
              (estimatedTokens.outputTokens / 1_000_000) * worker.costPerMillionOutputTokens;
          }
          note = note
            ? `${note}; actual chunk count: ${actualChunks} (from chapter splitting)`
            : `Actual chunk count: ${actualChunks} (from chapter splitting)`;
        }
      }
    }

    return {
      source: basename(source.path),
      path: source.path,
      type: source.type,
      sizeBytes,
      sizeKB,
      estimatedDocumentTokens: documentTokens,
      assignedWorkers: resolvedWorkers,
      estimatedTokens,
      estimatedCost,
      usedActuals,
      actualChunks,
      note,
    };
  }
}

/**
 * Synthesize a WorkerConfig from a flat ExtractionConfig (backward compatibility).
 * Used when no worker pool is configured.
 */
export function singleWorkerFromConfig(config: ExtractionConfig): WorkerConfig {
  const maxChunkSize = config.maxChunkSize ?? 100_000;
  // Estimate context window from maxChunkSize
  const contextWindow = Math.ceil(maxChunkSize / DEFAULT_CHARS_PER_TOKEN) + DEFAULT_PROMPT_OVERHEAD_TOKENS + (config.maxTokens ?? 4096);

  return {
    name: 'default',
    endpoint: config.endpoint,
    model: config.model,
    contextWindow,
    maxChunkSize,
    maxOutputTokens: config.maxTokens ?? 4096,
    costPerMillionInputTokens: 0,
    costPerMillionOutputTokens: 0,
    temperature: config.temperature,
    extraBodyParams: config.extraBodyParams,
    concurrency: config.concurrency,
    capabilities: ['structured-extraction', 'prose-extraction', 'large-context'],
  };
}

/**
 * Given a failed source and the list of available workers, reassign to a
 * more capable worker. Returns the new worker name or null if no upgrade is available.
 * Excludes all workers already assigned to the source.
 */
export function reassignFailedSource(
  source: IndexSource,
  workers: WorkerConfig[],
  currentWorkerName: string,
): string | null {
  const error = source.lastError ?? '';
  const currentWorker = workers.find(w => w.name === currentWorkerName);
  if (!currentWorker) return null;

  // Exclude all workers already assigned to this source
  const excludedWorkers = new Set(source.assignedWorkers ?? []);
  excludedWorkers.add(currentWorkerName);

  // Build candidates: workers that are strictly more capable than current
  const candidates = workers.filter(w => {
    if (excludedWorkers.has(w.name)) return false;

    // Context window errors → need larger context
    if (isContextError(error)) {
      return w.contextWindow > currentWorker.contextWindow;
    }

    // JSON parse / output errors → need better instruction following (higher cost = proxy for quality)
    if (isOutputError(error)) {
      const currentCost = currentWorker.costPerMillionInputTokens + currentWorker.costPerMillionOutputTokens;
      const candidateCost = w.costPerMillionInputTokens + w.costPerMillionOutputTokens;
      return candidateCost > currentCost || w.contextWindow > currentWorker.contextWindow;
    }

    // Generic failures → try the next cheapest worker with more capabilities
    return w.contextWindow > currentWorker.contextWindow ||
      w.capabilities.length > currentWorker.capabilities.length;
  });

  if (candidates.length === 0) return null;

  // Prefer the cheapest viable upgrade
  candidates.sort((a, b) => {
    const aCost = a.costPerMillionInputTokens + a.costPerMillionOutputTokens;
    const bCost = b.costPerMillionInputTokens + b.costPerMillionOutputTokens;
    return aCost - bCost;
  });

  return candidates[0]!.name;
}

/**
 * Estimate the cost of full extraction validation.
 *
 * Token estimates per item:
 * - Input: ~1,500 tokens (item data + source refs + ~2 tool calls at ~500 tokens each)
 * - Output: ~200 tokens (JSON verdict response)
 */
export function estimateValidationCost(
  totalEntities: number,
  totalRelationships: number,
  config: FullValidationConfig,
): ValidationCostEstimate {
  const totalItems = totalEntities + totalRelationships;
  const batchSize = config.batchSize;
  const totalBatches = Math.ceil(totalItems / batchSize);

  // Conservative token estimate per item (includes ~2 tool calls)
  const inputTokensPerItem = 1_500;
  const outputTokensPerItem = 200;

  const estimatedInputTokens = totalItems * inputTokensPerItem;
  const estimatedOutputTokens = totalItems * outputTokensPerItem;

  const costByWorker: Record<string, string> = {};
  for (const worker of config.workers) {
    const inputCost = (estimatedInputTokens / 1_000_000) * worker.costPerMillionInputTokens;
    const outputCost = (estimatedOutputTokens / 1_000_000) * worker.costPerMillionOutputTokens;
    costByWorker[worker.name] = `$${(inputCost + outputCost).toFixed(2)}`;
  }

  // Hybrid estimate if configured
  if (config.hybrid) {
    const firstPassWorker = config.workers.find(w => w.name === config.hybrid!.firstPass);
    const escalationWorker = config.workers.find(w => w.name === config.hybrid!.escalation);
    if (firstPassWorker && escalationWorker) {
      // Assume ~10% escalation rate
      const escalationItems = Math.ceil(totalItems * 0.1);
      const firstPassItems = totalItems;
      const hybridInputCost =
        (firstPassItems * inputTokensPerItem / 1_000_000) * firstPassWorker.costPerMillionInputTokens +
        (escalationItems * inputTokensPerItem / 1_000_000) * escalationWorker.costPerMillionInputTokens;
      const hybridOutputCost =
        (firstPassItems * outputTokensPerItem / 1_000_000) * firstPassWorker.costPerMillionOutputTokens +
        (escalationItems * outputTokensPerItem / 1_000_000) * escalationWorker.costPerMillionOutputTokens;
      costByWorker[`hybrid (${config.hybrid.firstPass} + ${config.hybrid.escalation} escalation)`] =
        `$${(hybridInputCost + hybridOutputCost).toFixed(2)}`;
    }
  }

  return {
    totalEntities,
    totalRelationships,
    totalBatches,
    estimatedInputTokens,
    estimatedOutputTokens,
    costByWorker,
  };
}

function isContextError(error: string): boolean {
  const lower = error.toLowerCase();
  return lower.includes('context') || lower.includes('too long') ||
    lower.includes('maximum') || lower.includes('token limit') ||
    lower.includes('exceed');
}

function isOutputError(error: string): boolean {
  const lower = error.toLowerCase();
  return lower.includes('json') || lower.includes('parse') ||
    lower.includes('empty response') || lower.includes('format');
}
