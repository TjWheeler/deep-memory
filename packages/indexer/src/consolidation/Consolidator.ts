import { randomUUID } from 'node:crypto';
import type { ExportArchive, ExportPipelineMetadata, StoredEntity, StoredRelationship, Provenance, MemoryVocabulary } from '@utaba/deep-memory';
import type { ConsolidationConfig } from '../types/config.js';
import type { ExtractionOutput, ExtractedEntity, ExtractedRelationship } from '../types/extraction.js';
import type { EntityRegistry, RegistryEntry } from '../types/registry.js';
import { EntityMatcher, type MatchResult } from './EntityMatcher.js';
import type { MergeEvent, MergeLog } from './types.js';
import { parseVocabularyMarkdown, augmentVocabularyFromData } from './VocabularyMarkdownParser.js';

declare const __DEEP_MEMORY_INDEXER_VERSION__: string | undefined;

/** Injected by tsup at build time; falls back to package.json version in dev/test */
const INDEXER_VERSION: string =
  typeof __DEEP_MEMORY_INDEXER_VERSION__ !== 'undefined'
    ? __DEEP_MEMORY_INDEXER_VERSION__
    : '0.1.0';

/** Report generated during consolidation */
export interface ConsolidationReport {
  entitiesIdentified: number;
  entitiesMerged: number;
  entitiesNew: number;
  relationshipsIdentified: number;
  relationshipsMerged: number;
  relationshipsSkipped: number;
  lowConfidenceDecisions: Array<{ entity: string; reason: string; resolution: string }>;
}

/** Context passed to consolidation for populating pipeline and legal metadata in the archive */
export interface ConsolidationPipelineContext {
  /** LLM model used for extraction (e.g. "claude-sonnet-4-20250514") */
  extractionModel: string;
  /** LLM provider name (e.g. "anthropic", "vllm") */
  extractionProvider?: string;
  /** Embeddings model used (e.g. "Qwen/Qwen3-Embedding-8B") */
  embeddingsModel?: string;
  /** Extraction parameters */
  parameters?: {
    chunkSize?: number;
    chunkOverlap?: number;
    maxOutputTokens?: number;
  };
  /** Legal/copyright metadata to embed in the archive */
  legal?: import('@utaba/deep-memory').ExportLegalMetadata;
}

/** Entry in the label-to-entity lookup map (multi-valued to handle shared labels) */
interface LabelLookupEntry {
  id: string;
  entityType: string;
}

/** An entity candidate grouped from all extraction outputs */
interface EntityCandidate {
  entityType: string;
  label: string;
  summary?: string;
  properties: Record<string, unknown>;
  aliases: string[];
  sourceDocuments: string[];
}

/**
 * Consolidation pipeline phase — deduplicates entities across all extraction
 * outputs, assigns GUIDs, resolves relationship references, and produces an
 * ExportArchive ready for import.
 *
 * For deterministic deduplication (exact slug, alias match, high-confidence
 * Jaro-Winkler), runs locally without LLM calls. Low-confidence cases are
 * recorded in the report for manual review or future Reasoning Agent integration.
 */
export class Consolidator {
  readonly config: ConsolidationConfig;
  readonly vocabulary: string;

  constructor(config: ConsolidationConfig, vocabulary: string) {
    this.config = config;
    this.vocabulary = vocabulary;
  }

  /**
   * Consolidate all extraction outputs into a deduplicated entity registry
   * and ExportArchive.
   */
  async consolidate(
    extractions: ExtractionOutput[],
    existingRegistry?: EntityRegistry,
    repositoryId?: string,
    pipelineContext?: ConsolidationPipelineContext,
  ): Promise<{ registry: EntityRegistry; archive: ExportArchive; report: ConsolidationReport; mergeLog: MergeLog }> {
    const report: ConsolidationReport = {
      entitiesIdentified: 0,
      entitiesMerged: 0,
      entitiesNew: 0,
      relationshipsIdentified: 0,
      relationshipsMerged: 0,
      relationshipsSkipped: 0,
      lowConfidenceDecisions: [],
    };

    const mergeEvents: MergeEvent[] = [];

    // 1. Collect all entities from all extractions
    const allEntities = this.collectEntities(extractions);
    report.entitiesIdentified = allEntities.length;

    // 2. Deduplicate entities — merge candidates with matching type+label/alias
    const candidates = this.deduplicateEntities(allEntities, report, mergeEvents);

    // 3. Match against existing registry and assign GUIDs
    const { registry, candidateIdMap } = this.buildRegistry(
      candidates,
      existingRegistry,
      repositoryId ?? existingRegistry?.repositoryId ?? randomUUID(),
      report,
      mergeEvents,
    );

    // 4. Build label-to-GUID lookup from registry
    const labelToId = this.buildLabelLookup(registry);

    // 5. Collect and deduplicate relationships
    const allRelationships = this.collectRelationships(extractions);
    report.relationshipsIdentified = allRelationships.length;
    const resolvedRelationships = this.resolveRelationships(allRelationships, labelToId, report);

    // 6. Build StoredEntity[] and StoredRelationship[]
    const now = new Date().toISOString();
    const provenance = makeProvenance(now);

    const storedEntities: StoredEntity[] = candidates.map((c, i) => {
      const mapped = candidateIdMap.get(i);
      if (!mapped) {
        throw new Error(`Consolidation bug: candidate "${c.label}" (${c.entityType}) at index ${i} has no registry mapping. This indicates a mismatch between buildRegistry and the candidate list.`);
      }
      return {
        id: mapped.id,
        slug: mapped.slug,
        entityType: c.entityType,
        label: c.label,
        summary: c.summary,
        properties: c.properties,
        provenance,
      };
    });

    const storedRelationships: StoredRelationship[] = resolvedRelationships.map(r => ({
      id: randomUUID(),
      relationshipType: r.type,
      sourceEntityId: r.sourceEntityId,
      targetEntityId: r.targetEntityId,
      properties: r.properties,
      bidirectional: false,
      provenance,
    }));

    // 7. Build pipeline metadata from extractions and context
    const pipeline: ExportPipelineMetadata | undefined = pipelineContext
      ? {
          extractionModel: pipelineContext.extractionModel,
          extractionProvider: pipelineContext.extractionProvider,
          embeddingsModel: pipelineContext.embeddingsModel,
          sourceCount: extractions.length,
          sources: extractions.map(e => e.source),
          parameters: pipelineContext.parameters,
        }
      : undefined;

    // 8. Build ExportArchive
    const archive: ExportArchive = {
      manifest: {
        formatVersion: '1.0.0',
        libraryVersion: INDEXER_VERSION,
        exportedAt: now,
        exportedBy: { actorId: 'indexer-consolidator', actorType: 'agent' },
        repository: {
          repositoryId: registry.repositoryId,
          label: 'Consolidated Import',
          vocabularyVersion: '1.0.0',
          governanceMode: 'open',
        },
        statistics: {
          entityCount: storedEntities.length,
          relationshipCount: storedRelationships.length,
          entityTypeBreakdown: countByField(storedEntities, 'entityType'),
          relationshipTypeBreakdown: countByField(storedRelationships, 'relationshipType'),
        },
        legal: pipelineContext?.legal,
        pipeline,
      },
      vocabulary: this.buildVocabulary(storedEntities, storedRelationships),
      entities: storedEntities,
      relationships: storedRelationships,
    };

    const mergeLog: MergeLog = {
      generatedAt: now,
      totalEvents: mergeEvents.length,
      events: mergeEvents,
    };

    return { registry, archive, report, mergeLog };
  }

  // ── Entity Collection & Deduplication ───────────────────────────

  private collectEntities(extractions: ExtractionOutput[]): Array<ExtractedEntity & { sourceDoc: string }> {
    const all: Array<ExtractedEntity & { sourceDoc: string }> = [];
    for (const extraction of extractions) {
      for (const entity of extraction.entities) {
        all.push({ ...entity, sourceDoc: extraction.source });
      }
    }
    return all;
  }

  /** Merge entities with matching type + label/alias across documents */
  private deduplicateEntities(
    entities: Array<ExtractedEntity & { sourceDoc: string }>,
    report: ConsolidationReport,
    mergeEvents: MergeEvent[],
  ): EntityCandidate[] {
    const candidates = new Map<string, EntityCandidate>();

    for (const entity of entities) {
      const key = `${entity.entityType}:${entity.label.toLowerCase()}`;

      // Check if this entity matches an existing candidate by alias
      let matchKey: string | undefined;
      for (const [k, candidate] of candidates) {
        if (candidate.entityType !== entity.entityType) continue;
        const candidateLabels = [candidate.label.toLowerCase(), ...candidate.aliases.map(a => a.toLowerCase())];
        const entityLabels = [entity.label.toLowerCase(), ...entity.aliases.map(a => a.toLowerCase())];
        if (candidateLabels.some(cl => entityLabels.includes(cl))) {
          matchKey = k;
          break;
        }
      }

      const existing = candidates.get(matchKey ?? key);
      if (existing) {
        // Merge into existing candidate
        report.entitiesMerged++;
        mergeEvents.push({
          canonicalLabel: existing.label,
          entityType: entity.entityType,
          mergedLabel: entity.label,
          matchedBy: matchKey ? 'alias' : 'exact-label',
          confidence: matchKey ? 0.95 : 1.0,
          mergedFromSources: [entity.sourceDoc],
          canonicalSources: [...existing.sourceDocuments],
          mergedPropertyKeys: Object.keys(entity.properties),
          canonicalPropertyKeys: Object.keys(existing.properties),
        });
        existing.properties = { ...entity.properties, ...existing.properties };
        if (entity.summary && (!existing.summary || entity.summary.length > existing.summary.length)) {
          existing.summary = entity.summary;
        }
        for (const alias of [entity.label, ...entity.aliases]) {
          if (!existing.aliases.map(a => a.toLowerCase()).includes(alias.toLowerCase()) &&
              alias.toLowerCase() !== existing.label.toLowerCase()) {
            existing.aliases.push(alias);
          }
        }
        if (!existing.sourceDocuments.includes(entity.sourceDoc)) {
          existing.sourceDocuments.push(entity.sourceDoc);
        }
      } else {
        candidates.set(key, {
          entityType: entity.entityType,
          label: entity.label,
          summary: entity.summary,
          properties: entity.properties,
          aliases: [...entity.aliases],
          sourceDocuments: [entity.sourceDoc],
        });
      }
    }

    return [...candidates.values()];
  }

  // ── Registry Building ───────────────────────────────────────────

  private buildRegistry(
    candidates: EntityCandidate[],
    existingRegistry: EntityRegistry | undefined,
    repositoryId: string,
    report: ConsolidationReport,
    mergeEvents: MergeEvent[],
  ): { registry: EntityRegistry; candidateIdMap: Map<number, { id: string; slug: string }> } {
    const existingEntries = existingRegistry?.entities ?? [];
    const matcher = new EntityMatcher(existingEntries);
    const entries: RegistryEntry[] = [...existingEntries];
    const candidateIdMap = new Map<number, { id: string; slug: string }>();

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      // Check if this candidate matches an existing registry entry
      const matchResult: MatchResult = matcher.match({
        entityType: candidate.entityType,
        label: candidate.label,
        aliases: candidate.aliases,
        properties: candidate.properties,
        sourceRefs: [],
      });

      if (matchResult.match && matchResult.confidence >= 0.9) {
        // Update existing entry with new source documents and aliases
        const existing = entries.find(e => e.id === matchResult.match!.id)!;
        existing.status = 'consolidated';
        for (const doc of candidate.sourceDocuments) {
          if (!existing.sourceDocuments.includes(doc)) {
            existing.sourceDocuments.push(doc);
          }
        }
        for (const alias of candidate.aliases) {
          if (!existing.aliases.map(a => a.toLowerCase()).includes(alias.toLowerCase())) {
            existing.aliases.push(alias);
          }
        }
        mergeEvents.push({
          canonicalLabel: matchResult.match!.label,
          entityType: candidate.entityType,
          mergedLabel: candidate.label,
          matchedBy: matchResult.matchedBy as MergeEvent['matchedBy'],
          confidence: matchResult.confidence,
          mergedFromSources: candidate.sourceDocuments,
          canonicalSources: [...existing.sourceDocuments],
          mergedPropertyKeys: Object.keys(candidate.properties),
          canonicalPropertyKeys: [],
        });
        candidateIdMap.set(i, { id: existing.id, slug: existing.slug });
        report.entitiesMerged++;
      } else if (matchResult.match && matchResult.confidence >= 0.8) {
        // Low confidence — record for review, still merge
        report.lowConfidenceDecisions.push({
          entity: candidate.label,
          reason: `Possible match with "${matchResult.match.label}" (${matchResult.matchedBy}, confidence: ${matchResult.confidence.toFixed(2)})`,
          resolution: 'auto-merged (confidence >= 0.8)',
        });
        const existing = entries.find(e => e.id === matchResult.match!.id)!;
        existing.status = 'consolidated';
        for (const doc of candidate.sourceDocuments) {
          if (!existing.sourceDocuments.includes(doc)) {
            existing.sourceDocuments.push(doc);
          }
        }
        mergeEvents.push({
          canonicalLabel: matchResult.match!.label,
          entityType: candidate.entityType,
          mergedLabel: candidate.label,
          matchedBy: matchResult.matchedBy as MergeEvent['matchedBy'],
          confidence: matchResult.confidence,
          mergedFromSources: candidate.sourceDocuments,
          canonicalSources: [...existing.sourceDocuments],
          mergedPropertyKeys: Object.keys(candidate.properties),
          canonicalPropertyKeys: [],
        });
        candidateIdMap.set(i, { id: existing.id, slug: existing.slug });
        report.entitiesMerged++;
      } else {
        // New entity — assign GUID
        report.entitiesNew++;
        const id = randomUUID();
        const slug = `${candidate.entityType}:${slugify(candidate.label)}`;
        entries.push({
          id,
          slug,
          entityType: candidate.entityType,
          label: candidate.label,
          status: 'consolidated',
          aliases: candidate.aliases,
          sourceDocuments: candidate.sourceDocuments,
        });
        candidateIdMap.set(i, { id, slug });
      }
    }

    return {
      registry: {
        version: '1.0.0',
        repositoryId,
        lastUpdated: new Date().toISOString(),
        entities: entries,
      },
      candidateIdMap,
    };
  }

  // ── Relationship Resolution ─────────────────────────────────────

  private collectRelationships(extractions: ExtractionOutput[]): ExtractedRelationship[] {
    const all: ExtractedRelationship[] = [];
    for (const extraction of extractions) {
      all.push(...extraction.relationships);
    }
    return all;
  }

  /** Build a lookup from label (and aliases) to entity entries — multi-valued to handle shared labels */
  private buildLabelLookup(registry: EntityRegistry): Map<string, LabelLookupEntry[]> {
    const lookup = new Map<string, LabelLookupEntry[]>();
    const addEntry = (key: string, entry: LabelLookupEntry): void => {
      const normalised = key.toLowerCase();
      const existing = lookup.get(normalised);
      if (existing) {
        if (!existing.some(e => e.id === entry.id)) {
          existing.push(entry);
        }
      } else {
        lookup.set(normalised, [entry]);
      }
    };
    for (const entry of registry.entities) {
      const lookupEntry: LabelLookupEntry = { id: entry.id, entityType: entry.entityType };
      addEntry(entry.label, lookupEntry);
      addEntry(entry.slug, lookupEntry);
      for (const alias of entry.aliases) {
        addEntry(alias, lookupEntry);
      }
    }
    return lookup;
  }

  /** Resolve relationship labels to GUIDs and deduplicate, using vocabulary type constraints to disambiguate shared labels */
  private resolveRelationships(
    relationships: ExtractedRelationship[],
    labelToEntries: Map<string, LabelLookupEntry[]>,
    report: ConsolidationReport,
  ): Array<{ type: string; sourceEntityId: string; targetEntityId: string; properties: Record<string, unknown> }> {
    // Parse vocabulary for relationship type constraints
    const vocab = this.parseBaseVocabulary();
    const relTypeDefs = new Map<string, { allowedSourceTypes?: string[]; allowedTargetTypes?: string[] }>();
    if (vocab?.relationshipTypes) {
      for (const rt of vocab.relationshipTypes) {
        relTypeDefs.set(rt.type, {
          allowedSourceTypes: rt.allowedSourceTypes,
          allowedTargetTypes: rt.allowedTargetTypes,
        });
      }
    }

    const seen = new Map<string, { type: string; sourceEntityId: string; targetEntityId: string; properties: Record<string, unknown> }>();

    for (const rel of relationships) {
      const sourceEntries = labelToEntries.get(rel.sourceLabel.toLowerCase());
      const targetEntries = labelToEntries.get(rel.targetLabel.toLowerCase());

      if (!sourceEntries?.length || !targetEntries?.length) {
        report.relationshipsSkipped++;
        continue;
      }

      // Use vocabulary constraints to disambiguate when multiple entities share a label
      const typeDef = relTypeDefs.get(rel.type);
      const sourceId = resolveEntityFromEntries(sourceEntries, typeDef?.allowedSourceTypes);
      const targetId = resolveEntityFromEntries(targetEntries, typeDef?.allowedTargetTypes);

      if (!sourceId || !targetId) {
        report.relationshipsSkipped++;
        continue;
      }

      const key = `${rel.type}:${sourceId}:${targetId}`;
      const existing = seen.get(key);
      if (existing) {
        // Merge properties (existing wins on conflicts)
        existing.properties = { ...rel.properties, ...existing.properties };
        report.relationshipsMerged++;
      } else {
        seen.set(key, {
          type: rel.type,
          sourceEntityId: sourceId,
          targetEntityId: targetId,
          properties: rel.properties,
        });
      }
    }

    return [...seen.values()];
  }

  // ── Vocabulary Parsing ──────────────────────────────────────────

  /** Parse the vocabulary string (JSON or markdown) into a MemoryVocabulary without augmentation */
  private parseBaseVocabulary(): MemoryVocabulary | null {
    try {
      return JSON.parse(this.vocabulary) as MemoryVocabulary;
    } catch {
      try {
        return parseVocabularyMarkdown(this.vocabulary);
      } catch {
        return null;
      }
    }
  }

  /**
   * Build a complete vocabulary from the vocabulary string (JSON or markdown)
   * and augment with any types found in the data but missing from the vocabulary.
   *
   * Priority order:
   * 1. If vocabulary is valid JSON MemoryVocabulary, use it directly
   * 2. If vocabulary is markdown, parse it into structured type definitions
   * 3. Augment with types inferred from actual entities/relationships
   */
  private buildVocabulary(entities: StoredEntity[], relationships: StoredRelationship[]): MemoryVocabulary {
    const vocabulary = this.parseBaseVocabulary() ?? parseVocabularyMarkdown(this.vocabulary);
    return augmentVocabularyFromData(vocabulary, entities, relationships);
  }
}

// ── Helpers ───────────────────────────────────────────────────────

/** Pick the correct entity from multiple lookup matches using vocabulary type constraints */
function resolveEntityFromEntries(entries: LabelLookupEntry[], allowedTypes?: string[]): string | undefined {
  if (entries.length === 1) return entries[0]!.id;
  if (!allowedTypes?.length) return entries[0]!.id;
  const filtered = entries.filter(e => allowedTypes.includes(e.entityType));
  return filtered.length > 0 ? filtered[0]!.id : entries[0]!.id;
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function makeProvenance(now: string): Provenance {
  return {
    createdBy: 'indexer-consolidator',
    createdByType: 'agent',
    createdAt: now,
    modifiedBy: 'indexer-consolidator',
    modifiedByType: 'agent',
    modifiedAt: now,
  };
}

function countByField<T>(items: T[], field: keyof T): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = String(item[field]);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
