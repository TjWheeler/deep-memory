import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OperationAbortedError } from '@utaba/deep-memory';
import type { LLMProvider, LLMToolUseMessage, LLMRequestOptions } from '../providers/LLMProvider.js';
import type { ExtractedEntity, ExtractedRelationship, SourceRef } from '../types/extraction.js';
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
  RemediationStep,
  RelationshipKey,
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
  /** Proposed structural remodels — parsed defensively, never trusted as-is. */
  remediations?: unknown;
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
  /** Proposed structural remodels — parsed defensively, never trusted as-is. */
  remediations?: unknown;
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
 * Turns granted after the tool-call cap is reached, during which the worker is
 * asked to conclude with the evidence gathered so far. These give a cooperative
 * model room to return a text verdict; a model that keeps emitting tool calls
 * instead is stopped by the hard per-batch turn ceiling.
 */
const CONCLUSION_GRACE_TURNS = 3;

/**
 * Note stamped on every item of a batch whose loop hit the hard turn ceiling
 * without a conclusive response. Deliberately distinct from the "did not return a
 * result" message so a runaway sequence is unmistakable in the report.
 */
const TURN_CEILING_EXHAUSTED_NOTE =
  'Validation exhausted the maximum turn count without a conclusive response — see logs for the runaway sequence.';

/** A parsed response with no verdicts — every batch item falls through to the missing-result path. */
const EMPTY_PARSED: RawValidationResponse = { entities: [], relationships: [] };

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
  private readonly maxTurnsPerBatch: number;
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
    // Hard ceiling on provider calls for one batch. Every non-terminal turn issues
    // at least one tool call, so the tool-call cap bounds the exploratory turns; the
    // grace turns are the only further calls permitted for the model to conclude.
    // Past this ceiling no additional provider call is made for the batch — the
    // invariant is a fixed upper bound on API calls per batch, independent of whether
    // the model ever cooperates.
    this.maxTurnsPerBatch = this.maxToolCallsPerBatch + CONCLUSION_GRACE_TURNS;
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
  public async validateBatch(
    batch: ValidationBatch,
    signal?: AbortSignal,
    isStopRequested?: () => Promise<boolean>,
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
    let turnCount = 0;
    let finalContent = '';
    let exhausted = false;

    while (true) {
      // A live abort or stop request must interrupt an in-progress batch within a
      // single turn — not only at batch boundaries — so both are checked before
      // every provider call, not once at entry.
      if (signal?.aborted) {
        throw new OperationAbortedError('Full validation batch');
      }
      if (isStopRequested && await isStopRequested()) {
        throw new OperationAbortedError('Full validation batch');
      }

      // Hard ceiling on provider calls for this batch. Once reached, the batch
      // concludes without another call regardless of whether the model ever returned
      // text — an uncooperative model cannot pin an unbounded number of API calls.
      if (turnCount >= this.maxTurnsPerBatch) {
        exhausted = true;
        break;
      }
      turnCount++;

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

    if (exhausted) {
      // The loop hit the hard turn ceiling without a conclusive response. Every item
      // is returned unverifiable with the distinct exhaustion note rather than throwing:
      // a throw would leave the batch pending for retry, re-triggering the same runaway
      // sequence on resume. A graceful unverifiable result records the outcome and lets
      // the run make progress.
      const entityResults = this.buildEntityResults(batch.items, EMPTY_PARSED, TURN_CEILING_EXHAUSTED_NOTE);
      const relationshipResults = this.buildRelationshipResults(batch.items, EMPTY_PARSED, TURN_CEILING_EXHAUSTED_NOTE);

      await this.writeLog(callId, 'exhausted', {
        batchIndex: batch.batchIndex,
        source: primaryItem.source,
        processingTimeMs,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        toolCallCount,
        turnCount,
        maxTurnsPerBatch: this.maxTurnsPerBatch,
        itemCount: batch.items.length,
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
    }

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

    const restructureInstructions = `
## Structural remediations (optional)

Some errors are not wrong values but wrong *modelling*: a value is a cross-reference or
deferral that points at material which should be its own entity, or an edge is attached to
the wrong endpoint. A field-level correction cannot fix these. When the correct fix is
structural, you MAY add a "remediations" array to that item — a list of primitive steps.
Several steps that together form one remodel are listed on the same item and are applied
atomically (all or nothing).

Only propose a remediation when you have direct evidence:
- Quote the cross-reference / deferral text itself, AND
- Confirm by reading the source that the referenced material actually exists.
Keep confidence conservative. Use ONLY the entity and relationship types listed under
"Vocabulary Types" above, spelled exactly — do not invent a type. Any created entity or
relationship MUST carry non-empty sourceRefs; a step without them is discarded.

Worked pattern (derive the real types and direction from the vocabulary and source — this
is a shape, not a fixed recipe): a cell whose value defers to material described elsewhere
is often best modelled as (1) create the referenced entity, choosing its type from the
vocabulary; (2) create a correctly-typed edge to it; (3) delete the edge or property that
mis-carried the deferral.

Each remediation step is one of:
- { "itemType":"entity","operation":"create","label":"<label>","sourceEvidence":"<quote>","evidenceLines":{"lineStart":N,"lineEnd":N},"confidence":0.0-1.0,"entity":{"entityType":"<VocabType>","label":"<label>","summary":"<optional>","properties":{...},"aliases":[],"sourceRefs":[{"description":"...","lineStart":N,"lineEnd":N}]} }
- { "itemType":"relationship","operation":"create",...base fields...,"relationship":{"type":"<VocabType>","sourceLabel":"<label>","targetLabel":"<label>","properties":{...},"sourceRefs":[{"description":"...","lineStart":N,"lineEnd":N}]} }
- { "itemType":"relationship","operation":"retarget",...base fields...,"relationshipKey":{"sourceLabel":"...","type":"...","targetLabel":"..."},"endpoint":"source"|"target","newLabel":"<label>" }
- { "itemType":"relationship","operation":"delete",...base fields...,"relationshipKey":{"sourceLabel":"...","type":"...","targetLabel":"..."} }
- { "itemType":"entity","operation":"delete",...base fields... }
("base fields" = label, sourceEvidence, evidenceLines, confidence, as shown in the create example.)`;

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
${vocabSection}${domainSection}${restructureInstructions}

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
      "notes": "<optional free-text explanation>",
      "remediations": [ /* optional — omit unless a structural remodel is warranted; step formats above */ ]
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
      "notes": "<optional>",
      "remediations": [ /* optional — omit unless a structural remodel is warranted; step formats above */ ]
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
    missingResultNote: string = 'Worker did not return a result for this entity',
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
        // No verdict for this entity — treat as unverifiable, recording why
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
            evidence: missingResultNote,
          })),
          aliasVerdicts: entity.aliases.map(alias => ({
            alias,
            verdict: 'unverifiable' as FullValidationVerdict,
            evidence: missingResultNote,
          })),
          notes: missingResultNote,
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

      const { steps, dropNotes } = parseRemediations(raw.remediations);

      results.push({
        source,
        entityType: entity.entityType,
        label: entity.label,
        entityVerdict,
        existenceVerdict: normalizeVerdict(raw.existenceVerdict) ?? 'unverifiable',
        classificationVerdict: normalizeVerdict(raw.classificationVerdict) ?? 'unverifiable',
        propertyVerdicts,
        aliasVerdicts,
        notes: appendDropNotes(raw.notes, dropNotes),
        ...(steps.length > 0 ? { remediations: steps } : {}),
      });
    }

    return results;
  }

  private buildRelationshipResults(
    items: ValidationBatchItem[],
    parsed: RawValidationResponse,
    missingResultNote: string = 'Worker did not return a result for this relationship',
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
            evidence: missingResultNote,
          })),
          notes: missingResultNote,
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

      const { steps, dropNotes } = parseRemediations(raw.remediations);

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
        notes: appendDropNotes(raw.notes, dropNotes),
        ...(steps.length > 0 ? { remediations: steps } : {}),
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

// ── Structural remediation parsing ──────────────────────────────────────
//
// A worker may attach proposed structural remodels to an item. The applier is
// deterministic and will reject anything malformed, so parsing is defensive: a
// step that fails to parse is dropped and a note is appended to the item — a bad
// proposal never fails the batch, and provenance is never synthesized (a created
// item with no sourceRefs is dropped rather than fabricated).

/** Parse a worker's raw remediations array, dropping malformed steps with a note. */
function parseRemediations(raw: unknown): { steps: RemediationStep[]; dropNotes: string[] } {
  const steps: RemediationStep[] = [];
  const dropNotes: string[] = [];
  if (!Array.isArray(raw)) return { steps, dropNotes };

  raw.forEach((entry, i) => {
    const result = parseRemediationStep(entry);
    if (result.step) {
      steps.push(result.step);
    } else {
      dropNotes.push(`Dropped structural remediation #${i + 1}: ${result.error}`);
    }
  });

  return { steps, dropNotes };
}

function parseRemediationStep(entry: unknown): { step?: RemediationStep; error?: string } {
  const rec = asRecord(entry);
  if (!rec) return { error: 'not an object' };

  const itemType = rec['itemType'];
  if (itemType !== 'entity' && itemType !== 'relationship') return { error: 'invalid itemType' };

  const operation = rec['operation'];
  if (
    operation !== 'update' && operation !== 'remove-property' &&
    operation !== 'delete' && operation !== 'create' && operation !== 'retarget'
  ) {
    return { error: 'invalid operation' };
  }

  const base = parseStepBase(rec);
  if (base.value === undefined) return { error: base.error };
  const { label, sourceEvidence, evidenceLines, confidence } = base.value;

  if (operation === 'create') {
    if (itemType === 'entity') {
      const entity = parseExtractedEntity(rec['entity']);
      if (!entity) return { error: 'invalid or missing entity payload' };
      if (entity.sourceRefs.length === 0) {
        return { error: 'created entity has no sourceRefs; provenance cannot be synthesized' };
      }
      return { step: { itemType: 'entity', operation: 'create', label, sourceEvidence, evidenceLines, confidence, entity } };
    }
    const relationship = parseExtractedRelationship(rec['relationship']);
    if (!relationship) return { error: 'invalid or missing relationship payload' };
    if (relationship.sourceRefs.length === 0) {
      return { error: 'created relationship has no sourceRefs; provenance cannot be synthesized' };
    }
    return { step: { itemType: 'relationship', operation: 'create', label, sourceEvidence, evidenceLines, confidence, relationship } };
  }

  if (operation === 'retarget') {
    if (itemType !== 'relationship') return { error: 'retarget requires itemType "relationship"' };
    const relationshipKey = parseRelationshipKey(rec['relationshipKey']);
    if (!relationshipKey) return { error: 'invalid or missing relationshipKey' };
    const endpoint = rec['endpoint'];
    if (endpoint !== 'source' && endpoint !== 'target') return { error: 'endpoint must be "source" or "target"' };
    const newLabel = rec['newLabel'];
    if (typeof newLabel !== 'string' || newLabel.trim().length === 0) return { error: 'missing newLabel' };
    return { step: { itemType: 'relationship', operation: 'retarget', label, sourceEvidence, evidenceLines, confidence, relationshipKey, endpoint, newLabel } };
  }

  if (operation === 'delete') {
    if (itemType === 'relationship') {
      const relationshipKey = parseRelationshipKey(rec['relationshipKey']);
      if (!relationshipKey) return { error: 'relationship delete requires relationshipKey' };
      return { step: { itemType: 'relationship', operation: 'delete', label, sourceEvidence, evidenceLines, confidence, relationshipKey } };
    }
    return { step: { itemType: 'entity', operation: 'delete', label, sourceEvidence, evidenceLines, confidence } };
  }

  // update | remove-property
  const property = rec['property'];
  if (typeof property !== 'string' || property.trim().length === 0) return { error: 'missing property' };
  const relationshipKey = itemType === 'relationship' ? parseRelationshipKey(rec['relationshipKey']) : undefined;
  if (itemType === 'relationship' && !relationshipKey) {
    return { error: 'relationship property correction requires relationshipKey' };
  }
  const originalValue = rec['originalValue'];
  if (operation === 'update') {
    if (!('correctedValue' in rec)) return { error: 'update requires correctedValue' };
    return {
      step: {
        itemType, operation: 'update', property,
        correctedValue: rec['correctedValue'], originalValue,
        ...(relationshipKey ? { relationshipKey } : {}),
        label, sourceEvidence, evidenceLines, confidence,
      },
    };
  }
  return {
    step: {
      itemType, operation: 'remove-property', property, originalValue,
      ...(relationshipKey ? { relationshipKey } : {}),
      label, sourceEvidence, evidenceLines, confidence,
    },
  };
}

interface StepBase {
  label: string;
  sourceEvidence: string;
  evidenceLines: { lineStart: number; lineEnd: number };
  confidence: number;
}

function parseStepBase(rec: Record<string, unknown>): { value: StepBase; error?: undefined } | { value?: undefined; error: string } {
  const label = rec['label'];
  if (typeof label !== 'string' || label.trim().length === 0) return { error: 'missing label' };
  const sourceEvidence = rec['sourceEvidence'];
  if (typeof sourceEvidence !== 'string' || sourceEvidence.trim().length === 0) {
    return { error: 'missing sourceEvidence (structural remediations require direct evidence)' };
  }
  const evidenceLines = parseLineRange(rec['evidenceLines']);
  if (!evidenceLines) return { error: 'missing or invalid evidenceLines' };
  const confidence = rec['confidence'];
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return { error: 'missing or invalid confidence' };
  // Confidence must be a real probability — an out-of-range value would clear the
  // apply-side minConfidence floor unconditionally (a group rides its weakest member),
  // so reject rather than clamp, consistent with dropping any other malformed field.
  if (confidence < 0 || confidence > 1) return { error: 'confidence out of range (must be between 0 and 1)' };
  return { value: { label, sourceEvidence, evidenceLines, confidence } };
}

function parseExtractedEntity(value: unknown): ExtractedEntity | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const entityType = rec['entityType'];
  const label = rec['label'];
  if (typeof entityType !== 'string' || entityType.trim().length === 0) return undefined;
  if (typeof label !== 'string' || label.trim().length === 0) return undefined;
  const summary = typeof rec['summary'] === 'string' ? rec['summary'] : undefined;
  return {
    entityType,
    label,
    ...(summary !== undefined ? { summary } : {}),
    properties: asRecord(rec['properties']) ?? {},
    aliases: asStringArray(rec['aliases']),
    sourceRefs: parseSourceRefs(rec['sourceRefs']),
  };
}

function parseExtractedRelationship(value: unknown): ExtractedRelationship | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const type = rec['type'];
  const sourceLabel = rec['sourceLabel'];
  const targetLabel = rec['targetLabel'];
  if (typeof type !== 'string' || type.trim().length === 0) return undefined;
  if (typeof sourceLabel !== 'string' || sourceLabel.trim().length === 0) return undefined;
  if (typeof targetLabel !== 'string' || targetLabel.trim().length === 0) return undefined;
  return {
    type,
    sourceLabel,
    targetLabel,
    properties: asRecord(rec['properties']) ?? {},
    sourceRefs: parseSourceRefs(rec['sourceRefs']),
  };
}

function parseRelationshipKey(value: unknown): RelationshipKey | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const sourceLabel = rec['sourceLabel'];
  const type = rec['type'];
  const targetLabel = rec['targetLabel'];
  if (typeof sourceLabel !== 'string' || sourceLabel.trim().length === 0) return undefined;
  if (typeof type !== 'string' || type.trim().length === 0) return undefined;
  if (typeof targetLabel !== 'string' || targetLabel.trim().length === 0) return undefined;
  return { sourceLabel, type, targetLabel };
}

function parseSourceRefs(value: unknown): SourceRef[] {
  if (!Array.isArray(value)) return [];
  const refs: SourceRef[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const range = parseLineRange(rec);
    if (!range) continue;
    const description = typeof rec['description'] === 'string' ? rec['description'] : '';
    refs.push({ description, lineStart: range.lineStart, lineEnd: range.lineEnd });
  }
  return refs;
}

function parseLineRange(value: unknown): { lineStart: number; lineEnd: number } | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const lineStart = rec['lineStart'];
  const lineEnd = rec['lineEnd'];
  if (typeof lineStart !== 'number' || !Number.isFinite(lineStart)) return undefined;
  if (typeof lineEnd !== 'number' || !Number.isFinite(lineEnd)) return undefined;
  return { lineStart, lineEnd };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Fold drop notes into the worker's free-text notes so the reason survives to review. */
function appendDropNotes(notes: string | undefined, dropNotes: string[]): string | undefined {
  if (dropNotes.length === 0) return notes;
  const suffix = dropNotes.join(' ');
  return notes && notes.trim().length > 0 ? `${notes} ${suffix}` : suffix;
}
