// Mapping — convert between Gremlin results and StoredEntity/StoredRelationship types

import type { StoredEntity } from '@utaba/deep-memory/types';
import type { StoredRelationship } from '@utaba/deep-memory/types';
import type { Provenance } from '@utaba/deep-memory/types';
import type { StoredRepository, StoredRepositorySummary } from '@utaba/deep-memory/types';
import type { GovernanceConfig } from '@utaba/deep-memory/types';
import type { VocabularyChangeRecord } from '@utaba/deep-memory/types';

// ─── Projection field lists ───────────────────────────────────────
//
// The GremlinCompiler emits read-path projections listing these exact field
// names. The mapper functions below (entityFromGremlin, relationshipFromGremlin)
// consume the same key set. Keeping the two in lockstep is enforced by the
// cross-package test in mapping.test.ts, which imports the compiler's own
// list and asserts equality.
//
// `embedding` is intentionally excluded — read paths never ship the embedding
// over the wire. The vector-search path will pass an explicit `loadEmbeddings`
// option (Phase 2) to opt back in.
//
// Synthetic projection-only fields (`__kind`) are NOT stored properties and
// are not in this list — the compiler adds them as discriminator markers but
// the mapper does not read them.

export const STORED_ENTITY_FIELDS = [
  'id',
  'entityType',
  'entityLabel',
  'slug',
  'summary',
  'properties',
  'data',
  'dataFormat',
  'createdBy',
  'createdByType',
  'createdAt',
  'createdInConversation',
  'createdFromMessage',
  'modifiedBy',
  'modifiedByType',
  'modifiedAt',
  'modifiedInConversation',
  'modifiedFromMessage',
] as const;

export const STORED_RELATIONSHIP_FIELDS = [
  'id',
  'relationshipType',
  'sourceEntityId',
  'targetEntityId',
  'properties',
  'bidirectional',
  'createdBy',
  'createdByType',
  'createdAt',
  'createdInConversation',
  'createdFromMessage',
  'modifiedBy',
  'modifiedByType',
  'modifiedAt',
  'modifiedInConversation',
  'modifiedFromMessage',
] as const;

// Repository projection — used by getRepository / listRepositories. The
// compiler does not deal with `_repository` vertices, so the projection chain
// lives here (no cross-package sync needed). Mirror what `repositoryFromGremlin`
// and `repositorySummaryFromGremlin` consume.
export const STORED_REPOSITORY_FIELDS = [
  'id',
  'repositoryId',
  'repoLabel',
  'description',
  'type',
  'legal',
  'owner',
  'governanceConfig',
  'metadata',
  'createdAt',
  'createdBy',
] as const;

/**
 * Build a Gremlin `.project(...).by(...)...` chain expression for a
 * `_repository` vertex, with no leading dot. Append after a vertex predicate.
 * `repoLabel`, `governanceConfig`, `createdAt`, `createdBy`, and `repositoryId`
 * are always written on create; the optional fields use coalesce-default-empty
 * to avoid the "by('optionalField') crashes when absent" failure mode (see
 * docs/cosmosdb-gremlin-compatibility.md §Constraints).
 */
export function buildRepositoryProjectChain(): string {
  return [
    `project('id','repositoryId','repoLabel','description','type','legal','owner','governanceConfig','metadata','createdAt','createdBy')`,
    `.by(id)`,
    `.by('repositoryId')`,
    `.by('repoLabel')`,
    `.by(coalesce(values('description'), constant('')))`,
    `.by(coalesce(values('type'), constant('')))`,
    `.by(coalesce(values('legal'), constant('')))`,
    `.by(coalesce(values('owner'), constant('')))`,
    `.by('governanceConfig')`,
    `.by(coalesce(values('metadata'), constant('')))`,
    `.by('createdAt')`,
    `.by('createdBy')`,
  ].join('');
}

// ─── Gremlin property extraction ──────────────────────────────────

/**
 * Gremlin valueMap(true) returns properties as arrays (multi-value).
 * CosmosDB single-cardinality means each array has exactly one element.
 * This helper unwraps the first value.
 */
function unwrap(val: unknown): unknown {
  if (Array.isArray(val) && val.length > 0) return val[0];
  return val;
}

/** Safely unwrap a string value from a Gremlin result. */
function unwrapStr(val: unknown): string {
  const v = unwrap(val);
  return typeof v === 'string' ? v : String(v ?? '');
}

/** Safely unwrap an optional string. */
function unwrapOptStr(val: unknown): string | undefined {
  const v = unwrap(val);
  return v != null && v !== '' ? String(v) : undefined;
}

/** Safely parse JSON, returning a default on failure. */
function safeParseJson<T>(val: unknown, fallback: T): T {
  if (val == null) return fallback;
  const str = typeof val === 'string' ? val : String(unwrap(val));
  if (!str || str === '') return fallback;
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}

// ─── Provenance ───────────────────────────────────────────────────

function provenanceFromGremlin(props: Record<string, unknown>): Provenance {
  return {
    createdBy: unwrapStr(props['createdBy']),
    createdByType: (unwrapStr(props['createdByType']) || 'agent') as 'user' | 'agent',
    createdAt: unwrapStr(props['createdAt']),
    createdInConversation: unwrapOptStr(props['createdInConversation']),
    createdFromMessage: unwrapOptStr(props['createdFromMessage']),
    modifiedBy: unwrapStr(props['modifiedBy']),
    modifiedByType: (unwrapStr(props['modifiedByType']) || 'agent') as 'user' | 'agent',
    modifiedAt: unwrapStr(props['modifiedAt']),
    modifiedInConversation: unwrapOptStr(props['modifiedInConversation']),
    modifiedFromMessage: unwrapOptStr(props['modifiedFromMessage']),
  };
}

// ─── Entity mapping ───────────────────────────────────────────────

export function entityFromGremlin(props: Record<string, unknown>): StoredEntity {
  const embeddingStr = unwrapOptStr(props['embedding']);
  return {
    id: unwrapStr(props['id']),
    slug: unwrapStr(props['slug']),
    entityType: unwrapStr(props['entityType']),
    label: unwrapStr(props['entityLabel']),
    summary: unwrapOptStr(props['summary']),
    properties: safeParseJson(unwrap(props['properties']), {}),
    data: unwrapOptStr(props['data']),
    dataFormat: unwrapOptStr(props['dataFormat']),
    provenance: provenanceFromGremlin(props),
    embedding: embeddingStr ? (safeParseJson<number[] | undefined>(embeddingStr, undefined)) : undefined,
  };
}

// ─── Relationship mapping ─────────────────────────────────────────

export function relationshipFromGremlin(props: Record<string, unknown>): StoredRelationship {
  const bidir = unwrap(props['bidirectional']);
  return {
    id: unwrapStr(props['id']),
    relationshipType: unwrapStr(props['relationshipType']),
    sourceEntityId: unwrapStr(props['sourceEntityId']),
    targetEntityId: unwrapStr(props['targetEntityId']),
    properties: safeParseJson(unwrap(props['properties']), {}),
    bidirectional: bidir === true || bidir === 'true',
    provenance: provenanceFromGremlin(props),
  };
}

// ─── Repository mapping ───────────────────────────────────────────

export function repositoryFromGremlin(props: Record<string, unknown>): StoredRepository {
  return {
    repositoryId: unwrapStr(props['repositoryId']),
    type: unwrapOptStr(props['type']),
    label: unwrapStr(props['repoLabel']),
    description: unwrapOptStr(props['description']),
    legal: unwrapOptStr(props['legal']),
    owner: unwrapOptStr(props['owner']),
    governanceConfig: safeParseJson<GovernanceConfig>(unwrap(props['governanceConfig']), { mode: 'open' }),
    metadata: safeParseJson(unwrap(props['metadata']), undefined),
    createdAt: unwrapStr(props['createdAt']),
    createdBy: unwrapStr(props['createdBy']),
  };
}

export function repositorySummaryFromGremlin(props: Record<string, unknown>): StoredRepositorySummary {
  return {
    repositoryId: unwrapStr(props['repositoryId']),
    type: unwrapOptStr(props['type']),
    label: unwrapStr(props['repoLabel']),
    description: unwrapOptStr(props['description']),
    governanceConfig: safeParseJson<GovernanceConfig>(unwrap(props['governanceConfig']), { mode: 'open' }),
  };
}

// ─── Vocabulary change-log mapping ────────────────────────────────

export function changeRecordFromGremlin(props: Record<string, unknown>): VocabularyChangeRecord {
  return {
    changeId: unwrapStr(props['changeId']),
    changeType: unwrapStr(props['changeType']) as VocabularyChangeRecord['changeType'],
    typeName: unwrapStr(props['typeName']),
    previousVersion: unwrapOptStr(props['previousVersion']),
    newVersion: unwrapStr(props['newVersion']),
    proposedBy: unwrapStr(props['proposedBy']),
    proposedAt: unwrapStr(props['proposedAt']),
    approvedBy: unwrapOptStr(props['approvedBy']),
    approvedAt: unwrapOptStr(props['approvedAt']),
    reason: unwrapStr(props['reason']),
  };
}

// ─── Property serialization helpers ───────────────────────────────

/** Build a flat property map for a vertex from a StoredEntity. */
export function entityToGremlinProps(
  repositoryId: string,
  entity: StoredEntity,
): Record<string, string | number | boolean> {
  const props: Record<string, string | number | boolean> = {
    repositoryId,
    entityType: entity.entityType,
    entityLabel: entity.label,
    slug: entity.slug,
    properties: JSON.stringify(entity.properties ?? {}),
    createdBy: entity.provenance.createdBy,
    createdByType: entity.provenance.createdByType,
    createdAt: entity.provenance.createdAt,
    modifiedBy: entity.provenance.modifiedBy,
    modifiedByType: entity.provenance.modifiedByType,
    modifiedAt: entity.provenance.modifiedAt,
  };
  if (entity.summary != null) props['summary'] = entity.summary;
  if (entity.data != null) props['data'] = entity.data;
  if (entity.dataFormat != null) props['dataFormat'] = entity.dataFormat;
  if (entity.provenance.createdInConversation != null) props['createdInConversation'] = entity.provenance.createdInConversation;
  if (entity.provenance.createdFromMessage != null) props['createdFromMessage'] = entity.provenance.createdFromMessage;
  if (entity.provenance.modifiedInConversation != null) props['modifiedInConversation'] = entity.provenance.modifiedInConversation;
  if (entity.provenance.modifiedFromMessage != null) props['modifiedFromMessage'] = entity.provenance.modifiedFromMessage;
  if (entity.embedding != null) props['embedding'] = JSON.stringify(entity.embedding);
  return props;
}

/** Build a flat property map for an edge from a StoredRelationship. */
export function relationshipToGremlinProps(
  repositoryId: string,
  rel: StoredRelationship,
): Record<string, string | number | boolean> {
  const props: Record<string, string | number | boolean> = {
    repositoryId,
    relationshipType: rel.relationshipType,
    sourceEntityId: rel.sourceEntityId,
    targetEntityId: rel.targetEntityId,
    bidirectional: rel.bidirectional,
    properties: JSON.stringify(rel.properties ?? {}),
    createdBy: rel.provenance.createdBy,
    createdByType: rel.provenance.createdByType,
    createdAt: rel.provenance.createdAt,
    modifiedBy: rel.provenance.modifiedBy,
    modifiedByType: rel.provenance.modifiedByType,
    modifiedAt: rel.provenance.modifiedAt,
  };
  if (rel.provenance.createdInConversation != null) props['createdInConversation'] = rel.provenance.createdInConversation;
  if (rel.provenance.createdFromMessage != null) props['createdFromMessage'] = rel.provenance.createdFromMessage;
  if (rel.provenance.modifiedInConversation != null) props['modifiedInConversation'] = rel.provenance.modifiedInConversation;
  if (rel.provenance.modifiedFromMessage != null) props['modifiedFromMessage'] = rel.provenance.modifiedFromMessage;
  return props;
}
