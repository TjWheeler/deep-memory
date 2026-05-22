import { readFile } from 'node:fs/promises';
import type { ExtractionOutput, ExtractedEntity } from '../types/extraction.js';
import type {
  Tier2Result,
  ValidationIssue,
  VerificationResponse,
  PropertyVerdict,
} from '../types/validation.js';

interface VerificationConfig {
  endpoint: string;
  model: string;
}

/**
 * Tier 2 VerificationWorker — source-grounded LLM verification.
 *
 * Reads the source text referenced by sourceRefs and asks an LLM to verify
 * that the extracted data is actually supported by the source. Low cost
 * (~500-1000 tokens per entity).
 */
export class VerificationWorker {
  constructor(private readonly config: VerificationConfig) {}

  /**
   * Verify extracted entities against their source text.
   *
   * @param extraction - The extraction output to verify
   * @param sourceContent - The full source document text
   * @param scope - Which entities to verify: all, a random sample, or only those with flagged properties
   * @param samplePercent - Percentage of entities to sample (when scope is 'sample')
   * @param flaggedProperties - Property names flagged by Tier 1 (when scope is 'flagged-only')
   */
  async verify(
    extraction: ExtractionOutput,
    sourceContent: string,
    scope: 'all' | 'sample' | 'flagged-only',
    samplePercent?: number,
    flaggedProperties?: Set<string>,
  ): Promise<{ tier2: Tier2Result; issues: ValidationIssue[] }> {
    const sourceLines = sourceContent.split('\n');
    const entitiesToVerify = selectEntities(extraction, scope, samplePercent, flaggedProperties);

    let totalProperties = 0;
    let confirmed = 0;
    let unsupported = 0;
    let contradicted = 0;
    const issues: ValidationIssue[] = [];

    for (const entity of entitiesToVerify) {
      const sourceText = extractSourceText(entity, sourceLines);
      if (!sourceText) continue;

      const propertyEntries = Object.entries(entity.properties);
      if (propertyEntries.length === 0) continue;

      totalProperties += propertyEntries.length;

      const response = await this.callVerificationLLM(entity, sourceText);

      for (const [propName, propValue] of propertyEntries) {
        const propVerdict = response.properties[propName];
        if (!propVerdict) continue;

        switch (propVerdict.verdict) {
          case 'confirmed':
            confirmed++;
            break;

          case 'unsupported':
            unsupported++;
            issues.push({
              tier: 2,
              severity: 'warning',
              entityLabel: entity.label,
              property: propName,
              message: `[verification] Property "${propName}" on "${entity.label}" is unsupported by source text`,
              extractedValue: propValue,
              sourceEvidence: propVerdict.evidence,
              verdict: 'unsupported',
            });
            break;

          case 'contradicted':
            contradicted++;
            issues.push({
              tier: 2,
              severity: 'error',
              entityLabel: entity.label,
              property: propName,
              message: `[verification] Property "${propName}" on "${entity.label}" is contradicted by source text`,
              extractedValue: propValue,
              sourceEvidence: propVerdict.evidence,
              verdict: 'contradicted',
            });
            break;
        }
      }
    }

    const tier2: Tier2Result = {
      entitiesVerified: entitiesToVerify.length,
      propertiesVerified: totalProperties,
      confirmed,
      unsupported,
      contradicted,
      passed: contradicted === 0,
    };

    return { tier2, issues };
  }

  /**
   * Call the LLM to verify entity properties against source text.
   */
  private async callVerificationLLM(
    entity: ExtractedEntity,
    sourceText: string,
  ): Promise<VerificationResponse> {
    const propertyLines = Object.entries(entity.properties)
      .map(([key, value]) => `  Property: ${key} = ${JSON.stringify(value)}`)
      .join('\n');

    const systemPrompt = `You are a fact-checking agent. Compare the extracted data against the source text.
For each property, respond with:
- "confirmed" if the source text explicitly states or directly implies this value
- "unsupported" if the source text does not mention this value (possible hallucination)
- "contradicted" if the source text states a different value

Respond ONLY with JSON in this exact format:
{ "properties": { "<propertyName>": { "verdict": "confirmed|unsupported|contradicted", "evidence": "<brief quote or explanation>" } } }`;

    const userPrompt = `Extracted entity:
  Type: ${entity.entityType}
  Label: ${entity.label}
${propertyLines}

Source text:
${sourceText}

Verify each property against the source text. Respond with JSON only.`;

    const url = `${this.config.endpoint.replace(/\/$/, '')}/chat/completions`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 2048,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Verification LLM error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content = data.choices[0]?.message?.content;

    if (!content) {
      throw new Error('Verification LLM returned empty response');
    }

    return parseVerificationResponse(content);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Select which entities to verify based on scope */
function selectEntities(
  extraction: ExtractionOutput,
  scope: 'all' | 'sample' | 'flagged-only',
  samplePercent?: number,
  flaggedProperties?: Set<string>,
): ExtractedEntity[] {
  switch (scope) {
    case 'all':
      return extraction.entities;

    case 'sample': {
      const pct = samplePercent ?? 20;
      const count = Math.max(1, Math.ceil(extraction.entities.length * pct / 100));
      // Deterministic shuffle using source name as seed
      const shuffled = [...extraction.entities].sort((a, b) =>
        hashCode(`${extraction.source}:${a.label}`) - hashCode(`${extraction.source}:${b.label}`),
      );
      return shuffled.slice(0, count);
    }

    case 'flagged-only': {
      if (!flaggedProperties || flaggedProperties.size === 0) return [];
      return extraction.entities.filter(entity =>
        Object.keys(entity.properties).some(prop => flaggedProperties.has(`${entity.label}:${prop}`)),
      );
    }
  }
}

/** Extract source text lines referenced by an entity's sourceRefs */
function extractSourceText(entity: ExtractedEntity, sourceLines: string[]): string | null {
  if (entity.sourceRefs.length === 0) return null;

  const textSegments: string[] = [];

  for (const ref of entity.sourceRefs) {
    // sourceRefs are 1-indexed
    const start = Math.max(0, ref.lineStart - 1);
    const end = Math.min(sourceLines.length, ref.lineEnd);

    if (start >= end) continue;

    const lines = sourceLines.slice(start, end);
    textSegments.push(`[Lines ${ref.lineStart}-${ref.lineEnd}: ${ref.description}]\n${lines.join('\n')}`);
  }

  return textSegments.length > 0 ? textSegments.join('\n\n') : null;
}

/** Parse the LLM verification response */
function parseVerificationResponse(content: string): VerificationResponse {
  // Strip thinking tags and code fences
  let json = content.trim();
  json = json.replace(/^<think>[\s\S]*?<\/think>\s*/i, '');
  json = json.trim();
  if (json.startsWith('```')) {
    json = json.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // Return empty result on parse failure rather than crashing
    return { properties: {} };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { properties: {} };
  }

  const obj = parsed as Record<string, unknown>;
  const rawProperties = obj['properties'] as Record<string, unknown> | undefined;

  if (!rawProperties || typeof rawProperties !== 'object') {
    return { properties: {} };
  }

  const properties: Record<string, PropertyVerdict> = {};
  for (const [key, value] of Object.entries(rawProperties)) {
    if (typeof value === 'object' && value !== null) {
      const v = value as Record<string, unknown>;
      const verdict = v['verdict'] as string;
      if (verdict === 'confirmed' || verdict === 'unsupported' || verdict === 'contradicted') {
        properties[key] = {
          verdict,
          evidence: String(v['evidence'] ?? ''),
        };
      }
    }
  }

  return { properties };
}

/** Simple hash code for deterministic sampling */
function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash;
}

/** Read source document content from disk */
export async function readSourceContent(sourcePath: string): Promise<string> {
  return readFile(sourcePath, 'utf-8');
}

interface ChatCompletionResponse {
  choices: Array<{
    message?: {
      content?: string;
    };
  }>;
}
