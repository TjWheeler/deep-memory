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

// ─── Document-endpoint mapping ────────────────────────────────────
//
// Cosmos NoSQL (Document) endpoint sees Gremlin-managed properties as
// `[{ _value, id }]` arrays rather than flat scalars. The Gremlin reserved
// scalars (`id`, the partition-key `repositoryId`, the vertex `label` token)
// stay flat on the document. Probed and confirmed 2026-05-26 — see
// local-tests/baseline/phase-cosmos-sql-shape-probe-results.md.

/** Pluck the underlying value of a Gremlin-managed property from a Document-endpoint doc. */
function pluckDocValue(doc: Record<string, unknown>, key: string): unknown {
  const arr = doc[key];
  if (Array.isArray(arr) && arr.length > 0) {
    const entry = arr[0] as Record<string, unknown> | undefined;
    if (entry && typeof entry === 'object') {
      return entry['_value'];
    }
  }
  return undefined;
}

function pluckDocStr(doc: Record<string, unknown>, key: string): string {
  const v = pluckDocValue(doc, key);
  return typeof v === 'string' ? v : String(v ?? '');
}

function pluckDocOptStr(doc: Record<string, unknown>, key: string): string | undefined {
  const v = pluckDocValue(doc, key);
  return v != null && v !== '' ? String(v) : undefined;
}

function provenanceFromDocument(doc: Record<string, unknown>): Provenance {
  return {
    createdBy: pluckDocStr(doc, 'createdBy'),
    createdByType: (pluckDocStr(doc, 'createdByType') || 'agent') as 'user' | 'agent',
    createdAt: pluckDocStr(doc, 'createdAt'),
    createdInConversation: pluckDocOptStr(doc, 'createdInConversation'),
    createdFromMessage: pluckDocOptStr(doc, 'createdFromMessage'),
    modifiedBy: pluckDocStr(doc, 'modifiedBy'),
    modifiedByType: (pluckDocStr(doc, 'modifiedByType') || 'agent') as 'user' | 'agent',
    modifiedAt: pluckDocStr(doc, 'modifiedAt'),
    modifiedInConversation: pluckDocOptStr(doc, 'modifiedInConversation'),
    modifiedFromMessage: pluckDocOptStr(doc, 'modifiedFromMessage'),
  };
}

/**
 * Project a Document-endpoint result row into a StoredEntity. Distinct from
 * `entityFromGremlin` (which reads the projected `valueMap`-style shape) —
 * here every Gremlin-managed property is `[{_value, id}]` while `id` and the
 * `label` token are flat. The `entityType` *property* (not the `label` token)
 * is authoritative — see `packages/storage-cosmosdb/src/queries/entity.ts`
 * for the matching write-path decision.
 */
export function entityFromDocument(doc: Record<string, unknown>): StoredEntity {
  const id = typeof doc['id'] === 'string' ? doc['id'] : String(doc['id'] ?? '');
  const embeddingStr = pluckDocOptStr(doc, 'embedding');
  return {
    id,
    slug: pluckDocStr(doc, 'slug'),
    entityType: pluckDocStr(doc, 'entityType'),
    label: pluckDocStr(doc, 'entityLabel'),
    summary: pluckDocOptStr(doc, 'summary'),
    properties: safeParseJson(pluckDocValue(doc, 'properties'), {}),
    data: pluckDocOptStr(doc, 'data'),
    dataFormat: pluckDocOptStr(doc, 'dataFormat'),
    provenance: provenanceFromDocument(doc),
    embedding: embeddingStr ? safeParseJson<number[] | undefined>(embeddingStr, undefined) : undefined,
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

// ─── Phase 10 — fixed-shape property ladders ──────────────────────
//
// Every addV / addE / upsert write uses a canonical fixed-length property
// ladder so the Gremlin server can reuse the compiled plan across writes.
// Required slots emit `.property('key', pN)`; optional slots emit
// `.choose(__.constant(pN).is(neq(absentSentinel)), __.property('key', pN),
// __.identity())` — the choose-skip drops the property at runtime when the
// binding equals the sentinel, keeping the query string constant regardless
// of which optional fields the caller supplied.
//
// `id` and `repositoryId` are NOT part of these ladders — both are written
// explicitly at create time (`.property('id', vid).property('repositoryId',
// rid)`) and are immutable on update (Cosmos rejects partition-key mutation).
//
// Slot order is FIXED. Adding a new slot goes at the END only; reordering
// or removing breaks the cached plan + introduces a different query string.
//
// Verified live 2026-05-26 — see local-tests/phase10-shape-probe*.mjs and
// docs/cosmosdb-gremlin-compatibility.md (choose-skip / fixed-ladder entries).

/** Binding value used to signal an absent optional string slot. */
export const ABSENT_STRING_SENTINEL = '';

/** Binding name in the emitted query referencing the absent-sentinel value. */
const SENTINEL_BINDING = 'absentSentinel';

const ENTITY_REQUIRED_SLOTS = [
  'entityType',
  'entityLabel',
  'slug',
  'properties',
  'createdBy',
  'createdByType',
  'createdAt',
  'modifiedBy',
  'modifiedByType',
  'modifiedAt',
] as const;

const ENTITY_OPTIONAL_SLOTS = [
  'summary',
  'data',
  'dataFormat',
  'embedding',
  'createdInConversation',
  'createdFromMessage',
  'modifiedInConversation',
  'modifiedFromMessage',
] as const;

const RELATIONSHIP_REQUIRED_SLOTS = [
  'relationshipType',
  'sourceEntityId',
  'targetEntityId',
  'bidirectional',
  'properties',
  'createdBy',
  'createdByType',
  'createdAt',
  'modifiedBy',
  'modifiedByType',
  'modifiedAt',
] as const;

const RELATIONSHIP_OPTIONAL_SLOTS = [
  'createdInConversation',
  'createdFromMessage',
  'modifiedInConversation',
  'modifiedFromMessage',
] as const;

const REPOSITORY_REQUIRED_SLOTS = [
  'repoLabel',
  'governanceConfig',
  'createdAt',
  'createdBy',
] as const;

const REPOSITORY_OPTIONAL_SLOTS = [
  'description',
  'type',
  'legal',
  'owner',
  'metadata',
] as const;

function buildLadder(
  required: readonly string[],
  optional: readonly string[],
  paramPrefix: string,
): string {
  const parts: string[] = [];
  let i = 0;
  for (const slot of required) {
    parts.push(`.property('${slot}', ${paramPrefix}${i++})`);
  }
  for (const slot of optional) {
    parts.push(
      `.choose(__.constant(${paramPrefix}${i}).is(neq(${SENTINEL_BINDING})),` +
        ` __.property('${slot}', ${paramPrefix}${i}),` +
        ` __.identity())`,
    );
    i++;
  }
  return parts.join('');
}

function buildLadderBindings(
  required: readonly string[],
  optional: readonly string[],
  paramPrefix: string,
  values: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number | boolean> {
  const bindings: Record<string, string | number | boolean> = {};
  let i = 0;
  for (const slot of required) {
    const v = values[slot];
    if (v == null) {
      throw new Error(`Phase 10 fixed-ladder: required slot '${slot}' is null/undefined`);
    }
    bindings[`${paramPrefix}${i++}`] = v;
  }
  for (const slot of optional) {
    const v = values[slot];
    bindings[`${paramPrefix}${i++}`] = v ?? ABSENT_STRING_SENTINEL;
  }
  return bindings;
}

/**
 * Emit the entity property ladder — same Gremlin string for every entity
 * write regardless of which optional fields are present. Prepend the
 * vertex-create prefix (e.g. `addV(vertexLabel).property('id', vid)
 * .property('repositoryId', rid)`) when on a create branch; on an update
 * branch (existing vertex via `unfold()`) use this chain directly.
 */
export function buildEntityPropertyLadder(): string {
  return buildLadder(ENTITY_REQUIRED_SLOTS, ENTITY_OPTIONAL_SLOTS, 'p');
}

/** Build the canonical entity ladder bindings (p0..p17 + absentSentinel). */
export function entityToLadderBindings(
  entity: StoredEntity,
): Record<string, string | number | boolean> {
  const bindings = buildLadderBindings(ENTITY_REQUIRED_SLOTS, ENTITY_OPTIONAL_SLOTS, 'p', {
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
    summary: entity.summary,
    data: entity.data,
    dataFormat: entity.dataFormat,
    embedding: entity.embedding != null ? JSON.stringify(entity.embedding) : undefined,
    createdInConversation: entity.provenance.createdInConversation,
    createdFromMessage: entity.provenance.createdFromMessage,
    modifiedInConversation: entity.provenance.modifiedInConversation,
    modifiedFromMessage: entity.provenance.modifiedFromMessage,
  });
  bindings[SENTINEL_BINDING] = ABSENT_STRING_SENTINEL;
  return bindings;
}

/** Edge counterpart of `buildEntityPropertyLadder()` — different slot list. */
export function buildRelationshipPropertyLadder(): string {
  return buildLadder(RELATIONSHIP_REQUIRED_SLOTS, RELATIONSHIP_OPTIONAL_SLOTS, 'p');
}

/** Build the canonical relationship ladder bindings (p0..p14 + absentSentinel). */
export function relationshipToLadderBindings(
  rel: StoredRelationship,
): Record<string, string | number | boolean> {
  const bindings = buildLadderBindings(
    RELATIONSHIP_REQUIRED_SLOTS,
    RELATIONSHIP_OPTIONAL_SLOTS,
    'p',
    {
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
      createdInConversation: rel.provenance.createdInConversation,
      createdFromMessage: rel.provenance.createdFromMessage,
      modifiedInConversation: rel.provenance.modifiedInConversation,
      modifiedFromMessage: rel.provenance.modifiedFromMessage,
    },
  );
  bindings[SENTINEL_BINDING] = ABSENT_STRING_SENTINEL;
  return bindings;
}

/**
 * Repository property ladder — slot list matches the writable surface of
 * StorageRepositoryConfig (the `id` and `repositoryId` slots are written
 * separately by the caller).
 */
export function buildRepositoryPropertyLadder(): string {
  return buildLadder(REPOSITORY_REQUIRED_SLOTS, REPOSITORY_OPTIONAL_SLOTS, 'p');
}

/** Build the canonical repository ladder bindings. */
export function repositoryConfigToLadderBindings(
  config: {
    label: string;
    governanceConfig: unknown;
    createdAt: string;
    createdBy: string;
    description?: string;
    type?: string;
    legal?: string;
    owner?: string;
    metadata?: Record<string, unknown>;
  },
): Record<string, string | number | boolean> {
  const bindings = buildLadderBindings(
    REPOSITORY_REQUIRED_SLOTS,
    REPOSITORY_OPTIONAL_SLOTS,
    'p',
    {
      repoLabel: config.label,
      governanceConfig: JSON.stringify(config.governanceConfig),
      createdAt: config.createdAt,
      createdBy: config.createdBy,
      description: config.description,
      type: config.type,
      legal: config.legal,
      owner: config.owner,
      metadata: config.metadata != null ? JSON.stringify(config.metadata) : undefined,
    },
  );
  bindings[SENTINEL_BINDING] = ABSENT_STRING_SENTINEL;
  return bindings;
}
