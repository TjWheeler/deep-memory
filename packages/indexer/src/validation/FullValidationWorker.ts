import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LLMProvider, LLMToolUseMessage, LLMRequestOptions } from '../providers/LLMProvider.js';
import { ValidationToolProvider } from './ValidationToolProvider.js';
import type {
  FullValidationWorkerConfig,
  ValidationBatch,
  ValidationBatchItem,
  BatchValidationResult,
  EntityValidationResult,
  RelationshipValidationResult,
  PropertyValidationResult,
  FullValidationVerdict,
} from './full-validation-types.js';

/** Raw validation response structure expected from the LLM */
interface RawValidationResponse {
  entities?: RawEntityValidation[];
  relationships?: RawRelationshipValidation[];
}

interface RawEntityValidation {
  label?: string;
  entityVerdict?: string;
  existenceVerdict?: string;
  classificationVerdict?: string;
  properties?: Record<string, RawPropertyVerdict>;
  aliases?: Record<string, RawAliasVerdict>;
  notes?: string;
}

interface RawRelationshipValidation {
  type?: string;
  sourceLabel?: string;
  targetLabel?: string;
  relationshipVerdict?: string;
  existenceVerdict?: string;
  typeVerdict?: string;
  directionalityVerdict?: string;
  properties?: Record<string, RawPropertyVerdict>;
  notes?: string;
}

interface RawPropertyVerdict {
  verdict?: string;
  evidence?: string;
  evidenceLines?: { lineStart?: number; lineEnd?: number };
  correction?: {
    correctedValue?: unknown;
    sourceEvidence?: string;
    evidenceLines?: { lineStart?: number; lineEnd?: number };
    confidence?: number;
  };
}

interface RawAliasVerdict {
  verdict?: string;
  evidence?: string;
}

/**
 * FullValidationWorker — LLM-powered agent that validates a batch of
 * extracted entities and relationships against their source documents.
 *
 * The worker uses tool-use to navigate source documents:
 * - read_source_lines: read specific lines
 * - search_source: search for terms
 * - read_source_section: read a named section
 * - list_source_headings: discover document structure
 * - read_other_source: cross-reference other documents
 *
 * After exploring the source, the worker returns a structured validation
 * response with per-entity and per-relationship verdicts.
 */
export class FullValidationWorker {
  private readonly maxToolCallsPerBatch: number;
  private callCounter = 0;

  constructor(
    private readonly config: FullValidationWorkerConfig,
    private readonly provider: LLMProvider,
    private readonly allSourcePaths: string[],
    private readonly logDir?: string,
    private readonly vocabularySummary?: string,
    private readonly domainGuidance?: string,
  ) {
    this.maxToolCallsPerBatch = config.maxToolCallsPerBatch ?? 20;
  }

  private async writeLog(callId: number, phase: string, data: Record<string, unknown>): Promise<void> {
    if (!this.logDir) return;
    try {
      await mkdir(this.logDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${timestamp}_validation-batch-${String(callId).padStart(4, '0')}_${phase}.json`;
      await writeFile(join(this.logDir, filename), JSON.stringify(data, null, 2) + '\n');
    } catch {
      // Logging must never break validation
    }
  }

  /**
   * Validate a single batch of entities/relationships.
   * Returns per-item verdicts and token usage.
   */
  async validateBatch(
    batch: ValidationBatch,
    signal?: AbortSignal,
  ): Promise<BatchValidationResult> {
    if (!this.provider.chatCompletionWithTools) {
      throw new Error(
        `LLM provider "${this.provider.name}" does not support tool use (chatCompletionWithTools). ` +
        'Full validation requires a provider that supports tool use.',
      );
    }

    const startTime = Date.now();
    const callId = ++this.callCounter;

    // Group items by primary source document
    // All items in a batch should share the same primary source (the orchestrator enforces this)
    const primaryItem = batch.items[0];
    if (!primaryItem) {
      return {
        batchIndex: batch.batchIndex,
        entityResults: [],
        relationshipResults: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        toolCalls: 0,
        processingTimeMs: 0,
        worker: this.config.name,
      };
    }

    const primarySourcePath = primaryItem.sourcePath;
    const toolProvider = new ValidationToolProvider(primarySourcePath, this.allSourcePaths);
    const tools = ValidationToolProvider.getToolDefinitions();

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(batch.items);

    try {

    await this.writeLog(callId, 'request', {
      batchIndex: batch.batchIndex,
      source: primaryItem.source,
      itemCount: batch.items.length,
      items: batch.items.map(i => i.type === 'entity'
        ? { type: 'entity', label: i.entity.label, entityType: i.entity.entityType }
        : { type: 'relationship', type_: i.relationship.type, sourceLabel: i.relationship.sourceLabel, targetLabel: i.relationship.targetLabel }),
      model: this.config.model,
      maxTokens: this.config.maxTokens,
      systemPromptLength: systemPrompt.length,
      userPromptLength: userPrompt.length,
      systemPrompt,
      userPrompt,
    });

    // Multi-turn conversation: start with the user prompt, loop until text response
    const messages: LLMToolUseMessage[] = [
      { role: 'user', content: userPrompt },
    ];

    const options: LLMRequestOptions = {
      model: this.config.model,
      temperature: 0,
      maxTokens: this.config.maxTokens,
      ...(this.config.extraBodyParams ? { extraBodyParams: this.config.extraBodyParams } : {}),
    };

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let toolCallCount = 0;
    let finalContent = '';

    while (true) {
      if (signal?.aborted) {
        throw new Error('Validation aborted');
      }

      const turn = await this.provider.chatCompletionWithTools(
        systemPrompt,
        messages,
        tools,
        options,
        signal,
      );

      totalInputTokens += turn.usage.inputTokens;
      totalOutputTokens += turn.usage.outputTokens;

      if (turn.type === 'text') {
        finalContent = turn.content ?? '';
        await this.writeLog(callId, `turn-${messages.length}-text`, {
          batchIndex: batch.batchIndex,
          turnIndex: messages.length,
          finishReason: turn.finish_reason,
          usage: turn.usage,
          toolCallsTotal: toolCallCount,
          contentLength: finalContent.length,
          content: finalContent,
        });
        break;
      }

      // Tool use — log and execute each tool call
      const toolCalls = turn.toolCalls ?? [];
      await this.writeLog(callId, `turn-${messages.length}-tool-use`, {
        batchIndex: batch.batchIndex,
        turnIndex: messages.length,
        usage: turn.usage,
        toolCalls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: tc.input })),
      });
      toolCallCount += toolCalls.length;

      if (toolCallCount > this.maxToolCallsPerBatch) {
        // Cap tool calls to prevent runaway exploration costs
        // Force the model to conclude by appending a user message
        messages.push({
          role: 'assistant',
          content: toolCalls.map(tc => ({
            type: 'tool_use' as const,
            id: tc.id,
            name: tc.name,
            input: tc.input,
          })),
        });
        // Provide truncated results and request conclusion
        const truncatedResults = toolCalls.map(tc => ({
          type: 'tool_result' as const,
          tool_use_id: tc.id,
          content: `[Tool call limit reached — ${this.maxToolCallsPerBatch} calls max per batch. Please conclude your validation with the evidence gathered so far.]`,
        }));
        messages.push({ role: 'user', content: truncatedResults });
        continue;
      }

      // Execute all tool calls
      const toolResults = await Promise.all(
        toolCalls.map(tc =>
          toolProvider.executeTool(tc.id, { name: tc.name, input: tc.input }),
        ),
      );

      // Append assistant message (tool_use blocks) then user message (tool_result blocks)
      messages.push({
        role: 'assistant',
        content: toolCalls.map(tc => ({
          type: 'tool_use' as const,
          id: tc.id,
          name: tc.name,
          input: tc.input,
        })),
      });
      messages.push({
        role: 'user',
        content: toolResults.map(r => ({
          type: 'tool_result' as const,
          tool_use_id: r.toolCallId,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      });
    }

    const processingTimeMs = Date.now() - startTime;

    // Parse the structured validation response from finalContent
    const parsed = parseValidationResponse(finalContent);
    const entityResults = this.buildEntityResults(batch.items, parsed);
    const relationshipResults = this.buildRelationshipResults(batch.items, parsed);

    await this.writeLog(callId, 'response', {
      batchIndex: batch.batchIndex,
      source: primaryItem.source,
      processingTimeMs,
      usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      toolCallCount,
      turns: messages.length,
      parsedEntityCount: parsed.entities?.length ?? 0,
      parsedRelationshipCount: parsed.relationships?.length ?? 0,
      entityResults: entityResults.map(r => ({ label: r.label, verdict: r.entityVerdict })),
      relationshipResults: relationshipResults.map(r => ({
        key: `${r.sourceLabel} → [${r.type}] → ${r.targetLabel}`,
        verdict: r.relationshipVerdict,
      })),
      rawResponse: finalContent,
    });

      return {
        batchIndex: batch.batchIndex,
        entityResults,
        relationshipResults,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        toolCalls: toolCallCount,
        processingTimeMs,
        worker: this.config.name,
      };
    } catch (error) {
      await this.writeLog(callId, 'error', {
        batchIndex: batch.batchIndex,
        source: primaryItem.source,
        processingTimeMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // ── Prompt Construction ─────────────────────────────────────────────

  private buildSystemPrompt(): string {
    const correctionInstructions = `\nFor properties with "mismatch" or "hallucinated" verdicts, you MUST also provide a correction:
- Find the correct value in the source document
- Include the source evidence (quoted text) and line numbers
- Rate your confidence in the correction (0.0-1.0)`;

    const vocabSection = this.vocabularySummary
      ? `\n${this.vocabularySummary}\n`
      : '';

    const domainSection = this.domainGuidance
      ? `\n## Domain Guidance\n\n${this.domainGuidance}\n`
      : '';

    return `You are a data accuracy validator for a knowledge graph extraction pipeline.
Your job is to verify that extracted entities and relationships accurately reflect what appears in the source documents.

For each entity and relationship, you MUST:
1. Read the source document at the referenced lines using the read_source_lines tool
2. Compare each property value against the source text
3. If the reference is unclear or insufficient, use search_source or read_source_section to find additional evidence
4. Assign a verdict for each property, alias, and the overall entity/relationship

Verdicts:
- "confirmed": value matches source text — you found supporting evidence
- "mismatch": value exists in source but is wrong (wrong field, wrong unit, different entity's data)
- "hallucinated": value does not appear in the source document — fabricated by the extraction model
- "unverifiable": source text is insufficient even after exploring additional sections
- "corrected": value was wrong; you have proposed a correction with source evidence

Rules:
- NEVER assign "confirmed" unless you have found explicit supporting evidence in the source
- If in doubt, investigate further before assigning a verdict
- Use list_source_headings to understand document structure when needed
- Use search_source when you can't find a value at the referenced lines
- Classification properties (listed below) use standardized vocabulary values. Confirm them if the source context supports the categorization, even if the exact value string does not appear verbatim in the source text. Only flag a classification value as "mismatch" if a different vocabulary value would be more accurate, or "hallucinated" if the entity has no relationship to that category at all${correctionInstructions}
${vocabSection}${domainSection}

After investigating, respond with a JSON object in this exact format:
{
  "entities": [
    {
      "label": "<entity label>",
      "entityVerdict": "<confirmed|mismatch|hallucinated|unverifiable>",
      "existenceVerdict": "<confirmed|mismatch|hallucinated|unverifiable>",
      "classificationVerdict": "<confirmed|mismatch|hallucinated|unverifiable>",
      "properties": {
        "<propertyName>": {
          "verdict": "<confirmed|mismatch|hallucinated|unverifiable|corrected>",
          "evidence": "<brief quote or explanation>",
          "evidenceLines": { "lineStart": N, "lineEnd": N },
          "correction": { "correctedValue": ..., "sourceEvidence": "...", "evidenceLines": { "lineStart": N, "lineEnd": N }, "confidence": 0.0-1.0 }
        }
      },
      "aliases": {
        "<alias>": { "verdict": "<confirmed|mismatch|hallucinated|unverifiable>", "evidence": "..." }
      },
      "notes": "<optional free-text explanation>"
    }
  ],
  "relationships": [
    {
      "type": "<relationship type>",
      "sourceLabel": "<source entity label>",
      "targetLabel": "<target entity label>",
      "relationshipVerdict": "<confirmed|mismatch|hallucinated|unverifiable>",
      "existenceVerdict": "<confirmed|mismatch|hallucinated|unverifiable>",
      "typeVerdict": "<confirmed|mismatch|hallucinated|unverifiable>",
      "directionalityVerdict": "<confirmed|mismatch|hallucinated|unverifiable>",
      "properties": { ... },
      "notes": "<optional>"
    }
  ]
}

Respond ONLY with the JSON object — no other text.`;
  }

  private buildUserPrompt(items: ValidationBatchItem[]): string {
    const entities = items.filter(i => i.type === 'entity');
    const relationships = items.filter(i => i.type === 'relationship');

    const parts: string[] = [
      `Validate the following extracted data against the source document.`,
    ];

    if (entities.length > 0) {
      parts.push('\n## Entities to Validate\n');
      for (const item of entities) {
        if (item.type !== 'entity') continue;
        const { entity, source } = item;
        const sourceRefsText = entity.sourceRefs.map(
          r => `  - Lines ${r.lineStart}-${r.lineEnd}: ${r.description}`,
        ).join('\n');

        parts.push(`### Entity: ${entity.label}
Source document: ${source}
Type: ${entity.entityType}
${entity.summary ? `Summary: ${entity.summary}\n` : ''}Properties:
${Object.entries(entity.properties).map(([k, v]) => `  - ${k}: ${JSON.stringify(v)}`).join('\n')}
${entity.aliases.length > 0 ? `Aliases: ${entity.aliases.join(', ')}\n` : ''}Source references:
${sourceRefsText}`);
      }
    }

    if (relationships.length > 0) {
      parts.push('\n## Relationships to Validate\n');
      for (const item of relationships) {
        if (item.type !== 'relationship') continue;
        const { relationship, source } = item;
        const sourceRefsText = relationship.sourceRefs.map(
          r => `  - Lines ${r.lineStart}-${r.lineEnd}: ${r.description}`,
        ).join('\n');

        parts.push(`### Relationship: ${relationship.sourceLabel} → [${relationship.type}] → ${relationship.targetLabel}
Source document: ${source}
${Object.keys(relationship.properties).length > 0 ? `Properties:\n${Object.entries(relationship.properties).map(([k, v]) => `  - ${k}: ${JSON.stringify(v)}`).join('\n')}\n` : ''}Source references:
${sourceRefsText}`);
      }
    }

    parts.push('\nStart by reading the source document at the referenced lines for each item.');
    return parts.join('\n');
  }

  // ── Result Building ─────────────────────────────────────────────────

  private buildEntityResults(
    items: ValidationBatchItem[],
    parsed: RawValidationResponse,
  ): EntityValidationResult[] {
    const results: EntityValidationResult[] = [];
    const rawByLabel = new Map<string, RawEntityValidation>();
    for (const raw of parsed.entities ?? []) {
      if (raw.label) rawByLabel.set(raw.label.toLowerCase(), raw);
    }

    for (const item of items) {
      if (item.type !== 'entity') continue;
      const { entity, source } = item;

      // Find matching raw result
      const raw = rawByLabel.get(entity.label.toLowerCase());

      if (!raw) {
        // Worker did not return a result for this entity — treat as unverifiable
        results.push({
          source,
          entityType: entity.entityType,
          label: entity.label,
          entityVerdict: 'unverifiable',
          existenceVerdict: 'unverifiable',
          classificationVerdict: 'unverifiable',
          propertyVerdicts: Object.keys(entity.properties).map(prop => ({
            property: prop,
            extractedValue: entity.properties[prop],
            verdict: 'unverifiable' as FullValidationVerdict,
            evidence: 'Worker did not return a result for this entity',
          })),
          aliasVerdicts: entity.aliases.map(alias => ({
            alias,
            verdict: 'unverifiable' as FullValidationVerdict,
            evidence: 'Worker did not return a result for this entity',
          })),
          notes: 'Worker did not return a result for this entity',
        });
        continue;
      }

      const propertyVerdicts: PropertyValidationResult[] = Object.entries(entity.properties).map(
        ([prop, value]) => {
          const rawProp = raw.properties?.[prop];
          return {
            property: prop,
            extractedValue: value,
            verdict: normalizeVerdict(rawProp?.verdict) ?? 'unverifiable',
            evidence: rawProp?.evidence ?? '',
            evidenceLines: rawProp?.evidenceLines?.lineStart != null && rawProp.evidenceLines.lineEnd != null
              ? { lineStart: rawProp.evidenceLines.lineStart, lineEnd: rawProp.evidenceLines.lineEnd }
              : undefined,
            correction: rawProp?.correction && rawProp.correction.correctedValue !== undefined
              ? {
                correctedValue: rawProp.correction.correctedValue,
                sourceEvidence: rawProp.correction.sourceEvidence ?? '',
                evidenceLines: {
                  lineStart: rawProp.correction.evidenceLines?.lineStart ?? 0,
                  lineEnd: rawProp.correction.evidenceLines?.lineEnd ?? 0,
                },
                confidence: rawProp.correction.confidence ?? 0,
              }
              : undefined,
          };
        },
      );

      const aliasVerdicts = entity.aliases.map(alias => {
        const rawAlias = raw.aliases?.[alias];
        return {
          alias,
          verdict: normalizeVerdict(rawAlias?.verdict) ?? 'unverifiable' as FullValidationVerdict,
          evidence: rawAlias?.evidence ?? '',
        };
      });

      const entityVerdict = computeOverallEntityVerdict(
        normalizeVerdict(raw.entityVerdict),
        propertyVerdicts,
      );

      results.push({
        source,
        entityType: entity.entityType,
        label: entity.label,
        entityVerdict,
        existenceVerdict: normalizeVerdict(raw.existenceVerdict) ?? 'unverifiable',
        classificationVerdict: normalizeVerdict(raw.classificationVerdict) ?? 'unverifiable',
        propertyVerdicts,
        aliasVerdicts,
        notes: raw.notes,
      });
    }

    return results;
  }

  private buildRelationshipResults(
    items: ValidationBatchItem[],
    parsed: RawValidationResponse,
  ): RelationshipValidationResult[] {
    const results: RelationshipValidationResult[] = [];
    const rawByKey = new Map<string, RawRelationshipValidation>();
    for (const raw of parsed.relationships ?? []) {
      if (raw.type && raw.sourceLabel && raw.targetLabel) {
        const key = `${raw.type}:${raw.sourceLabel.toLowerCase()}:${raw.targetLabel.toLowerCase()}`;
        rawByKey.set(key, raw);
      }
    }

    for (const item of items) {
      if (item.type !== 'relationship') continue;
      const { relationship, source } = item;

      const key = `${relationship.type}:${relationship.sourceLabel.toLowerCase()}:${relationship.targetLabel.toLowerCase()}`;
      const raw = rawByKey.get(key);

      if (!raw) {
        results.push({
          source,
          type: relationship.type,
          sourceLabel: relationship.sourceLabel,
          targetLabel: relationship.targetLabel,
          relationshipVerdict: 'unverifiable',
          existenceVerdict: 'unverifiable',
          typeVerdict: 'unverifiable',
          directionalityVerdict: 'unverifiable',
          propertyVerdicts: Object.keys(relationship.properties).map(prop => ({
            property: prop,
            extractedValue: relationship.properties[prop],
            verdict: 'unverifiable' as FullValidationVerdict,
            evidence: 'Worker did not return a result for this relationship',
          })),
          notes: 'Worker did not return a result for this relationship',
        });
        continue;
      }

      const propertyVerdicts: PropertyValidationResult[] = Object.entries(relationship.properties).map(
        ([prop, value]) => {
          const rawProp = raw.properties?.[prop];
          return {
            property: prop,
            extractedValue: value,
            verdict: normalizeVerdict(rawProp?.verdict) ?? 'unverifiable',
            evidence: rawProp?.evidence ?? '',
            evidenceLines: rawProp?.evidenceLines?.lineStart != null && rawProp.evidenceLines.lineEnd != null
              ? { lineStart: rawProp.evidenceLines.lineStart, lineEnd: rawProp.evidenceLines.lineEnd }
              : undefined,
            correction: rawProp?.correction && rawProp.correction.correctedValue !== undefined
              ? {
                correctedValue: rawProp.correction.correctedValue,
                sourceEvidence: rawProp.correction.sourceEvidence ?? '',
                evidenceLines: {
                  lineStart: rawProp.correction.evidenceLines?.lineStart ?? 0,
                  lineEnd: rawProp.correction.evidenceLines?.lineEnd ?? 0,
                },
                confidence: rawProp.correction.confidence ?? 0,
              }
              : undefined,
          };
        },
      );

      const relationshipVerdict = normalizeVerdict(raw.relationshipVerdict)
        ?? computeOverallRelationshipVerdict(propertyVerdicts);

      results.push({
        source,
        type: relationship.type,
        sourceLabel: relationship.sourceLabel,
        targetLabel: relationship.targetLabel,
        relationshipVerdict,
        existenceVerdict: normalizeVerdict(raw.existenceVerdict) ?? 'unverifiable',
        typeVerdict: normalizeVerdict(raw.typeVerdict) ?? 'unverifiable',
        directionalityVerdict: normalizeVerdict(raw.directionalityVerdict) ?? 'unverifiable',
        propertyVerdicts,
        notes: raw.notes,
      });
    }

    return results;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

const VALID_VERDICTS = new Set<FullValidationVerdict>([
  'confirmed', 'mismatch', 'hallucinated', 'unverifiable', 'corrected',
]);

function normalizeVerdict(raw: string | undefined): FullValidationVerdict | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase() as FullValidationVerdict;
  return VALID_VERDICTS.has(lower) ? lower : undefined;
}

/** Compute overall entity verdict from per-property verdicts */
function computeOverallEntityVerdict(
  rawVerdict: FullValidationVerdict | undefined,
  propertyVerdicts: PropertyValidationResult[],
): FullValidationVerdict {
  if (rawVerdict && rawVerdict !== 'unverifiable') return rawVerdict;

  // Derive from property verdicts: worst verdict wins
  const verdictPriority: Record<FullValidationVerdict, number> = {
    hallucinated: 5,
    mismatch: 4,
    corrected: 3,
    unverifiable: 2,
    confirmed: 1,
  };

  let worst: FullValidationVerdict = 'confirmed';
  for (const pv of propertyVerdicts) {
    if ((verdictPriority[pv.verdict] ?? 0) > (verdictPriority[worst] ?? 0)) {
      worst = pv.verdict;
    }
  }
  return worst;
}

/** Compute overall relationship verdict from per-property verdicts */
function computeOverallRelationshipVerdict(
  propertyVerdicts: PropertyValidationResult[],
): FullValidationVerdict {
  const verdictPriority: Record<FullValidationVerdict, number> = {
    hallucinated: 5,
    mismatch: 4,
    corrected: 3,
    unverifiable: 2,
    confirmed: 1,
  };

  let worst: FullValidationVerdict = 'confirmed';
  for (const pv of propertyVerdicts) {
    if ((verdictPriority[pv.verdict] ?? 0) > (verdictPriority[worst] ?? 0)) {
      worst = pv.verdict;
    }
  }
  return worst;
}

/** Parse and validate the LLM's JSON response */
function parseValidationResponse(content: string): RawValidationResponse {
  // Strip thinking tags and code fences
  let json = content.trim();
  json = json.replace(/^<think>[\s\S]*?<\/think>\s*/i, '').trim();
  if (json.startsWith('```')) {
    json = json.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
  }

  // Extract JSON object if wrapped in other text
  const jsonMatch = json.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    json = jsonMatch[0];
  }

  try {
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as RawValidationResponse;
    }
  } catch {
    // Fall through to empty result
  }

  return { entities: [], relationships: [] };
}
