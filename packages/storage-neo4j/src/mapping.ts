// Mapping — Neo4j driver records → StoredEntity / StoredRelationship.
//
// The mapper is the boundary that:
//   - Coerces `BigInt` integer values to safe `number` (per D6b — useBigInt is
//     enabled on the driver to avoid silent precision loss).
//   - Reads from either form of result row:
//       a) `RETURN n` — the alias resolves to a `Node` with a `.properties` map.
//       b) explicit projection (`RETURN n.id AS id, ...`) — the record carries
//          one entry per projected field.
//   - Treats the JSON-stringified `properties` blob as the source of truth for
//     `StoredEntity.properties` per the O1 resolution. Per-scalar properties
//     exist for query-time predicates only.
//
// This file deliberately does NOT import `neo4j-driver` — the driver chokepoint
// lives in `Neo4jConnection`. The minimal `DriverRecord` and node-like checks
// here are structurally compatible with `neo4j-driver`'s public types without
// pulling them in.

import { ProviderError } from '@utaba/deep-memory';
import type { StoredEntity } from '@utaba/deep-memory/types';
import type { StoredRelationship } from '@utaba/deep-memory/types';
import type { Provenance } from '@utaba/deep-memory/types';
import type {
  GovernanceConfig,
  RepositoryMetadata,
  StorageRepositoryConfig,
  StoredRepository,
  StoredRepositorySummary,
} from '@utaba/deep-memory/types';
import type { VocabularyChangeRecord } from '@utaba/deep-memory/types';

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * Minimal structural shape compatible with `neo4j-driver`'s `Record` class.
 * Keeping the type local lets the mapper compile without importing the driver,
 * which the isolation grep test forbids outside `Neo4jConnection.ts`.
 *
 * `keys` is `PropertyKey[]` rather than `string[]` because the driver's
 * `Record<T extends RecordShape>` types `keys` as `(keyof T)[]`, which TS
 * widens to `PropertyKey`. All of our projections use string-keyed Cypher
 * aliases, so the helpers filter to string keys at consumption time.
 */
export interface DriverRecord {
  keys: ReadonlyArray<PropertyKey>;
  get(key: string): unknown;
}

/**
 * Convert a `bigint` or `number` to a safe `number`, throwing `ProviderError`
 * when the value cannot be represented without precision loss. Used at every
 * public-API seam where a count, total, or server-time figure exits the
 * provider.
 *
 * The probe P2 results (local-tests/baseline/neo4j-phase3-probes-results.md)
 * confirm that `count(n)` aggregations and `summary.resultConsumedAfter` are
 * the only fields the boundary needs to coerce — scalar string / array
 * properties round-trip without `BigInt` wrapping.
 */
export function bigintToSafeNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') {
    if (value > MAX_SAFE_BIGINT || value < MIN_SAFE_BIGINT) {
      throw new ProviderError(
        `Neo4j integer value ${value.toString()} exceeds Number.MAX_SAFE_INTEGER — refusing to truncate.`,
      );
    }
    return Number(value);
  }
  throw new ProviderError(
    `bigintToSafeNumber expected bigint | number, received ${typeof value}.`,
  );
}

/**
 * Map a driver record to a `StoredEntity`. Accepts both `RETURN n` (alias
 * resolves to a `Node` with `.properties`) and explicit projection forms.
 *
 * `alias` defaults to `'n'`; pass an explicit alias if the query returned the
 * entity under a different name (e.g. `'node'` for the fulltext-index branch).
 */
export function entityFromRecord(record: DriverRecord, alias = 'n'): StoredEntity {
  return entityFromProperties(extractPropertyBag(record, alias));
}

/**
 * Map a driver record to a `StoredRelationship`. Accepts both `RETURN r` and
 * explicit projection forms. `alias` defaults to `'r'`.
 */
export function relationshipFromRecord(record: DriverRecord, alias = 'r'): StoredRelationship {
  return relationshipFromProperties(extractPropertyBag(record, alias));
}

/**
 * Map a flat property bag (i.e. the `properties` map of a Neo4j `Node`, or the
 * union of an explicit projection) to a `StoredEntity`.
 *
 * Exposed for tests and for callers that already have a property bag in hand
 * (e.g. when iterating `UNWIND` result rows).
 */
export function entityFromProperties(props: Record<string, unknown>): StoredEntity {
  const summary = optionalString(props, 'summary');
  const data = optionalString(props, 'data');
  const dataFormat = optionalString(props, 'dataFormat');
  const embedding = parseEmbedding(props);
  const entity: StoredEntity = {
    id: requireString(props, 'id'),
    slug: requireString(props, 'slug'),
    entityType: requireString(props, 'entityType'),
    label: requireString(props, 'label'),
    properties: parsePropertiesBlob(props),
    provenance: provenanceFromProperties(props),
  };
  if (summary !== undefined) entity.summary = summary;
  if (data !== undefined) entity.data = data;
  if (dataFormat !== undefined) entity.dataFormat = dataFormat;
  if (embedding !== undefined) entity.embedding = embedding;
  return entity;
}

/**
 * Map a flat property bag to a `StoredRelationship`. Mirror of
 * `entityFromProperties` for relationships.
 */
export function relationshipFromProperties(
  props: Record<string, unknown>,
): StoredRelationship {
  return {
    id: requireString(props, 'id'),
    relationshipType: requireString(props, 'relationshipType'),
    sourceEntityId: requireString(props, 'sourceEntityId'),
    targetEntityId: requireString(props, 'targetEntityId'),
    properties: parsePropertiesBlob(props),
    bidirectional: requireBoolean(props, 'bidirectional'),
    provenance: provenanceFromProperties(props),
  };
}

/**
 * Map a driver record to a `StoredRepository`. Accepts both `RETURN r` (alias
 * resolves to a `Node` with `.properties`) and explicit projection forms.
 *
 * `governanceConfig` and `metadata` are stored as JSON strings on the node;
 * read paths parse them back here so the public surface always sees the live
 * object shape. Optional string fields (`type`, `description`, `legal`,
 * `owner`) round-trip through `optionalString`.
 */
export function repositoryFromRecord(record: DriverRecord, alias = 'r'): StoredRepository {
  return repositoryFromProperties(extractPropertyBag(record, alias));
}

/**
 * Lighter projection used by `listRepositories` — omits `legal`, `owner`,
 * `metadata`, `createdAt`, `createdBy` per the `StoredRepositorySummary`
 * contract. Same JSON-parse-on-read for `governanceConfig`.
 */
export function repositorySummaryFromRecord(
  record: DriverRecord,
  alias = 'r',
): StoredRepositorySummary {
  return repositorySummaryFromProperties(extractPropertyBag(record, alias));
}

export function repositoryFromProperties(props: Record<string, unknown>): StoredRepository {
  const type = optionalString(props, 'type');
  const description = optionalString(props, 'description');
  const legal = optionalString(props, 'legal');
  const owner = optionalString(props, 'owner');
  const metadata = parseOptionalJsonObject<RepositoryMetadata>(props, 'metadata');
  const repo: StoredRepository = {
    repositoryId: requireString(props, 'repositoryId'),
    label: requireString(props, 'label'),
    governanceConfig: parseRequiredJsonObject<GovernanceConfig>(props, 'governanceConfig'),
    createdAt: requireString(props, 'createdAt'),
    createdBy: requireString(props, 'createdBy'),
  };
  if (type !== undefined) repo.type = type;
  if (description !== undefined) repo.description = description;
  if (legal !== undefined) repo.legal = legal;
  if (owner !== undefined) repo.owner = owner;
  if (metadata !== undefined) repo.metadata = metadata;
  return repo;
}

export function repositorySummaryFromProperties(
  props: Record<string, unknown>,
): StoredRepositorySummary {
  const type = optionalString(props, 'type');
  const description = optionalString(props, 'description');
  const summary: StoredRepositorySummary = {
    repositoryId: requireString(props, 'repositoryId'),
    label: requireString(props, 'label'),
    governanceConfig: parseRequiredJsonObject<GovernanceConfig>(props, 'governanceConfig'),
  };
  if (type !== undefined) summary.type = type;
  if (description !== undefined) summary.description = description;
  return summary;
}

/**
 * Map a driver record to a `VocabularyChangeRecord`. Accepts both
 * `RETURN e` (alias resolves to a `Node` with `.properties`) and explicit
 * projection forms; `alias` defaults to `'e'` to match the change-log query.
 *
 * The four optional traceability fields (`previousVersion`, `approvedBy`,
 * `approvedAt`, plus the user-supplied `reason`) round-trip via the same
 * `optionalString` / `requireString` helpers used elsewhere. The provenance
 * fields are intentionally NOT flattened into the surrounding provenance bag —
 * proposed/approved are a separate audit semantic from createdBy/modifiedBy.
 */
export function changeRecordFromRecord(
  record: DriverRecord,
  alias = 'e',
): VocabularyChangeRecord {
  return changeRecordFromProperties(extractPropertyBag(record, alias));
}

export function changeRecordFromProperties(
  props: Record<string, unknown>,
): VocabularyChangeRecord {
  const previousVersion = optionalString(props, 'previousVersion');
  const approvedBy = optionalString(props, 'approvedBy');
  const approvedAt = optionalString(props, 'approvedAt');
  const record: VocabularyChangeRecord = {
    changeId: requireString(props, 'changeId'),
    changeType: requireChangeType(props, 'changeType'),
    typeName: requireString(props, 'typeName'),
    newVersion: requireString(props, 'newVersion'),
    proposedBy: requireString(props, 'proposedBy'),
    proposedAt: requireString(props, 'proposedAt'),
    reason: requireString(props, 'reason'),
  };
  if (previousVersion !== undefined) record.previousVersion = previousVersion;
  if (approvedBy !== undefined) record.approvedBy = approvedBy;
  if (approvedAt !== undefined) record.approvedAt = approvedAt;
  return record;
}

/**
 * Field list projected by entity read paths — `getEntity`, `getEntityBySlug`,
 * `getEntities`, `findEntities`, `updateEntity` (projection-on-write).
 *
 * The list deliberately excludes `embedding` and `repositoryId`:
 *  - `embedding` is a heavy native `list<float>` carried only when callers
 *    opt in via `EntityReadOptions.loadEmbeddings`. `buildEntityProjection`
 *    appends it when requested.
 *  - `repositoryId` is the scope discriminator, not a `StoredEntity` field.
 *
 * Keeping this list in lockstep with `entityFromProperties` is enforced by the
 * co-located mapping tests — adding a new field requires updating both.
 */
export const STORED_ENTITY_FIELDS = [
  'id',
  'entityType',
  'label',
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

/**
 * Build a `RETURN` projection chain for an entity read. The result is a
 * comma-separated list of `n.<field> AS <field>` clauses that the caller
 * appends after `RETURN ` (or after `SET ... RETURN ` for projection-on-write).
 *
 * `embedding` is opt-in: pass `loadEmbeddings: true` to add `n.embedding AS
 * embedding` to the tail. `RETURN n.<field> AS <field>` after a `SET` ships
 * the post-SET state in the same round-trip, so `updateEntity` reuses this
 * projection for projection-on-write without a re-MATCH.
 *
 * `alias` defaults to `'n'`; the fulltext-index search branch uses `'node'`.
 */
export function buildEntityProjection(options?: {
  loadEmbeddings?: boolean;
  alias?: string;
}): string {
  const alias = options?.alias ?? 'n';
  const parts = STORED_ENTITY_FIELDS.map((field) => `${alias}.${field} AS ${field}`);
  if (options?.loadEmbeddings === true) {
    parts.push(`${alias}.embedding AS embedding`);
  }
  return parts.join(', ');
}

/**
 * Schema-managed property names on `:_Entity` nodes. User-supplied
 * `entity.properties` keys cannot collide with these — colliding would clobber
 * a schema-managed scalar via `SET n += $userProperties` and break round-trip.
 *
 * Kept as a frozen `Set` for O(1) membership checks on the write hot path.
 */
export const RESERVED_ENTITY_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  'id',
  'repositoryId',
  'entityType',
  'label',
  'slug',
  'summary',
  'properties',
  'data',
  'dataFormat',
  'embedding',
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
]);

/**
 * User-supplied property keys are interpolated into the Cypher string at
 * REMOVE-time (Cypher 25 cannot REMOVE a property whose key is bound at
 * run-time) and used in the predicate slot of `findEntities`. Restrict them
 * to the bare Cypher identifier shape so the interpolation cannot widen the
 * injection surface — same guard `assertSafeRelationshipType` applies to the
 * relationship-type slot.
 */
const USER_PROPERTY_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate a user-supplied entity property key. Throws `ProviderError` when
 * the key is not a bare Cypher identifier or collides with a schema-managed
 * field name. Both checks run on every write and every predicate emission —
 * the cost is one regex test plus one set lookup per key per call.
 */
export function assertSafeUserPropertyKey(key: string): string {
  if (!USER_PROPERTY_KEY_PATTERN.test(key)) {
    throw new ProviderError(
      `Entity property key "${key}" is not a valid Cypher identifier — must match ` +
        `${USER_PROPERTY_KEY_PATTERN.source}. User-property keys are interpolated into ` +
        `Cypher REMOVE / predicate slots (the key slot cannot be parameterised), so an ` +
        `unsafe value would widen the injection surface.`,
    );
  }
  if (RESERVED_ENTITY_PROPERTY_KEYS.has(key)) {
    throw new ProviderError(
      `Entity property key "${key}" collides with a schema-managed field. ` +
        `Reserved names: ${Array.from(RESERVED_ENTITY_PROPERTY_KEYS).join(', ')}.`,
    );
  }
  return key;
}

/**
 * Decide whether a value can be stored as a native Neo4j scalar property.
 * Native scalars are the predicate-queryable surface; non-storable values
 * (nested objects, `null`, heterogeneous arrays, arrays of objects) live only
 * inside the JSON-stringified `properties` blob and are NOT predicate-queryable.
 *
 * The set covers what Cypher's literal property syntax accepts uniformly:
 * `string`, finite `number`, `boolean`, and homogeneous arrays of those. The
 * driver passes these through Bolt without wrapping; everything else either
 * fails Bolt encoding or coerces to a shape Cypher cannot index.
 */
export function isNativeStorableValue(value: unknown): boolean {
  if (typeof value === 'string') return true;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return true;
    const first = value[0];
    const t = typeof first;
    if (t !== 'string' && t !== 'boolean' && (t !== 'number' || !Number.isFinite(first))) {
      return false;
    }
    for (const v of value) {
      if (typeof v !== t) return false;
      if (t === 'number' && !Number.isFinite(v as number)) return false;
    }
    return true;
  }
  return false;
}

/**
 * Build the parameter map for the schema-managed slots of the fixed-shape
 * entity `CREATE` template. Every schema field gets a binding on every call so
 * the planner reuses one cached plan across all entity creates (D15 — plan
 * cache friendliness).
 *
 * User-supplied `entity.properties` are NOT in this bag — they bind through
 * the separate `entityUserPropertyParams` helper and feed the
 * `SET n += $userProperties` clause that runs alongside the fixed CREATE. The
 * split keeps the CREATE plan-cache-keyed on a single Cypher string while
 * letting user-property keys live as native predicate-queryable scalars on
 * the node in addition to the JSON blob.
 *
 * Optional fields bind as `null`. Neo4j drops null properties on write —
 * symmetric with the read mapping where absent properties round-trip as
 * `undefined` via `optionalString`. The umbrella `:_Entity` label is the only
 * label written on the node; writing a per-type label as well would add
 * cold-compile and steady-state overhead with no offsetting benefit, since
 * every provider read filters via the indexed `n.entityType` property.
 *
 * `embedding` is bound as the native `number[]` — the Neo4j JS driver maps
 * `LIST<FLOAT>` directly to a JS `Array` with no wrapping, so no
 * JSON-stringify step — or `null` when absent.
 */
export function entityToParams(entity: StoredEntity): Record<string, unknown> {
  const p = entity.provenance;
  return {
    id: entity.id,
    entityType: entity.entityType,
    label: entity.label,
    slug: entity.slug,
    summary: entity.summary ?? null,
    properties: JSON.stringify(entity.properties),
    data: entity.data ?? null,
    dataFormat: entity.dataFormat ?? null,
    embedding: entity.embedding ?? null,
    createdBy: p.createdBy,
    createdByType: p.createdByType,
    createdAt: p.createdAt,
    createdInConversation: p.createdInConversation ?? null,
    createdFromMessage: p.createdFromMessage ?? null,
    modifiedBy: p.modifiedBy,
    modifiedByType: p.modifiedByType,
    modifiedAt: p.modifiedAt,
    modifiedInConversation: p.modifiedInConversation ?? null,
    modifiedFromMessage: p.modifiedFromMessage ?? null,
  };
}

/**
 * Project `entity.properties` to the native-scalar map fed to
 * `SET n += $userProperties`. Validates every key (no reserved-name
 * collision, identifier shape) and silently drops values that Neo4j cannot
 * store natively — those live only inside the JSON blob. The blob remains
 * authoritative for `entity.properties` round-trip via `entityFromProperties`,
 * so dropping a value here loses only its predicate-queryable shape, not its
 * read shape.
 *
 * The return is the bare map that binds to `$userProperties`; callers append
 * `SET n += $userProperties` to the CREATE / UPDATE template and bind this
 * value verbatim. An empty map is the no-op shape (`SET n += {}` is legal
 * Cypher and resets nothing), so the caller can emit the SET unconditionally.
 */
export function entityUserPropertyParams(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    assertSafeUserPropertyKey(key);
    if (isNativeStorableValue(value)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Field list projected by relationship read paths. Mirror of
 * `STORED_ENTITY_FIELDS` for `StoredRelationship` — `repositoryId` is the
 * scope discriminator, not a public field, so it is intentionally excluded
 * from the projection.
 *
 * Keeping this list in lockstep with `relationshipFromProperties` is enforced
 * by the co-located mapping tests — adding a new field requires updating both.
 */
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

/**
 * Build a `RETURN` projection chain for a relationship read. The result is a
 * comma-separated list of `r.<field> AS <field>` clauses; the caller appends
 * after `RETURN ` (or after UNION ALL branches that all project the same
 * shape).
 *
 * `alias` defaults to `'r'`. Each UNION branch must use the same alias and
 * the same field-name aliases to keep the union column-compatible.
 */
export function buildRelationshipProjection(options?: { alias?: string }): string {
  const alias = options?.alias ?? 'r';
  return STORED_RELATIONSHIP_FIELDS.map((field) => `${alias}.${field} AS ${field}`).join(', ');
}

/**
 * Build the parameter map for the fixed-shape relationship `CREATE` template.
 * Every field gets a binding on every call so the planner reuses one cached
 * plan per relationship type (D15) — the type slot is interpolated into the
 * Cypher string at compile time (the type slot cannot be parameterised in
 * Cypher 25), so the plan cache holds one entry per distinct vocabulary type.
 *
 * Optional fields bind as `null`. Neo4j drops null properties on write, so
 * absent fields are symmetric with their read-side `undefined`.
 *
 * `properties` is JSON-stringified into a single Neo4j property — relationship
 * properties are not indexed and are not predicate-queried server-side
 * (per O1/D6: indexed scalars live on entities only), so the blob round-trip
 * is sufficient.
 */
export function relationshipToParams(rel: StoredRelationship): Record<string, unknown> {
  const p = rel.provenance;
  return {
    id: rel.id,
    relationshipType: rel.relationshipType,
    sourceEntityId: rel.sourceEntityId,
    targetEntityId: rel.targetEntityId,
    properties: JSON.stringify(rel.properties ?? {}),
    bidirectional: rel.bidirectional,
    createdBy: p.createdBy,
    createdByType: p.createdByType,
    createdAt: p.createdAt,
    createdInConversation: p.createdInConversation ?? null,
    createdFromMessage: p.createdFromMessage ?? null,
    modifiedBy: p.modifiedBy,
    modifiedByType: p.modifiedByType,
    modifiedAt: p.modifiedAt,
    modifiedInConversation: p.modifiedInConversation ?? null,
    modifiedFromMessage: p.modifiedFromMessage ?? null,
  };
}

/**
 * Cypher 25 forbids parameterising the relationship-type slot (Cypher
 * identifier, not a value), so the type slug is concatenated directly into
 * the query string at compile time. This guard pins the value to the bare
 * identifier shape Cypher accepts unquoted, which is also the shape vocabulary
 * slugs already emit (UPPER_SNAKE_CASE per D5).
 *
 * Anything failing the guard is a programming error in the caller — either a
 * vocabulary value that bypassed slug normalisation, or a value handed in
 * directly without going through the relationship-create surface. Surfacing
 * it as `ProviderError` catches injection-shaped values at the chokepoint.
 */
const RELATIONSHIP_TYPE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertSafeRelationshipType(value: string): string {
  if (!RELATIONSHIP_TYPE_PATTERN.test(value)) {
    throw new ProviderError(
      `Relationship type "${value}" is not a valid Cypher identifier — must match ` +
        `${RELATIONSHIP_TYPE_PATTERN.source}. Cypher 25 does not allow parameterising ` +
        `the relationship-type slot, so the value is interpolated directly into the ` +
        `query string and an unsafe value would otherwise widen the injection surface.`,
    );
  }
  return value;
}

/**
 * Build the parameter map for `createRepository`'s fixed-shape `CREATE` Cypher.
 * Optional fields become `null` (Neo4j drops null properties on write, so the
 * resulting node has no property by that name — symmetric with read where
 * absent properties map to `undefined`).
 */
export function repositoryCreateParams(
  config: StorageRepositoryConfig,
): Record<string, unknown> {
  return {
    type: config.type ?? null,
    label: config.label,
    description: config.description ?? null,
    legal: config.legal ?? null,
    owner: config.owner ?? null,
    governanceConfig: JSON.stringify(config.governanceConfig),
    metadata: config.metadata !== undefined ? JSON.stringify(config.metadata) : null,
    createdAt: config.createdAt,
    createdBy: config.createdBy,
  };
}

// ─── Internal helpers ────────────────────────────────────────────────

function extractPropertyBag(record: DriverRecord, alias: string): Record<string, unknown> {
  if (record.keys.includes(alias)) {
    const value = record.get(alias);
    if (isNodeLike(value)) return value.properties;
    if (isRelationshipLike(value)) return value.properties;
  }
  const bag: Record<string, unknown> = {};
  for (const key of record.keys) {
    if (typeof key !== 'string') continue;
    bag[key] = record.get(key);
  }
  return bag;
}

function isNodeLike(value: unknown): value is { properties: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { properties?: unknown; labels?: unknown };
  return (
    typeof v.properties === 'object' &&
    v.properties !== null &&
    !Array.isArray(v.properties) &&
    Array.isArray(v.labels)
  );
}

function isRelationshipLike(
  value: unknown,
): value is { properties: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { properties?: unknown; type?: unknown };
  return (
    typeof v.properties === 'object' &&
    v.properties !== null &&
    !Array.isArray(v.properties) &&
    typeof v.type === 'string'
  );
}

function provenanceFromProperties(props: Record<string, unknown>): Provenance {
  const provenance: Provenance = {
    createdBy: requireString(props, 'createdBy'),
    createdByType: requireActorType(props, 'createdByType'),
    createdAt: requireString(props, 'createdAt'),
    modifiedBy: requireString(props, 'modifiedBy'),
    modifiedByType: requireActorType(props, 'modifiedByType'),
    modifiedAt: requireString(props, 'modifiedAt'),
  };
  const createdInConversation = optionalString(props, 'createdInConversation');
  const createdFromMessage = optionalString(props, 'createdFromMessage');
  const modifiedInConversation = optionalString(props, 'modifiedInConversation');
  const modifiedFromMessage = optionalString(props, 'modifiedFromMessage');
  if (createdInConversation !== undefined) provenance.createdInConversation = createdInConversation;
  if (createdFromMessage !== undefined) provenance.createdFromMessage = createdFromMessage;
  if (modifiedInConversation !== undefined) provenance.modifiedInConversation = modifiedInConversation;
  if (modifiedFromMessage !== undefined) provenance.modifiedFromMessage = modifiedFromMessage;
  return provenance;
}

function requireString(props: Record<string, unknown>, key: string): string {
  const value = props[key];
  if (typeof value !== 'string') {
    throw new ProviderError(
      `Neo4j record is missing required string field "${key}" (got ${describeType(value)}).`,
    );
  }
  return value;
}

function requireActorType(props: Record<string, unknown>, key: string): 'user' | 'agent' {
  const value = requireString(props, key);
  if (value !== 'user' && value !== 'agent') {
    throw new ProviderError(
      `Neo4j record field "${key}" must be "user" or "agent" (got ${JSON.stringify(value)}).`,
    );
  }
  return value;
}

const CHANGE_TYPES = [
  'entity_type_added',
  'relationship_type_added',
  'entity_type_modified',
  'relationship_type_modified',
  'entity_type_removed',
  'relationship_type_removed',
] as const satisfies ReadonlyArray<VocabularyChangeRecord['changeType']>;

function requireChangeType(
  props: Record<string, unknown>,
  key: string,
): VocabularyChangeRecord['changeType'] {
  const value = requireString(props, key);
  if (!(CHANGE_TYPES as readonly string[]).includes(value)) {
    throw new ProviderError(
      `Neo4j record field "${key}" must be one of the VocabularyChangeRecord change types ` +
        `(got ${JSON.stringify(value)}).`,
    );
  }
  return value as VocabularyChangeRecord['changeType'];
}

function requireBoolean(props: Record<string, unknown>, key: string): boolean {
  const value = props[key];
  if (typeof value !== 'boolean') {
    throw new ProviderError(
      `Neo4j record is missing required boolean field "${key}" (got ${describeType(value)}).`,
    );
  }
  return value;
}

function optionalString(props: Record<string, unknown>, key: string): string | undefined {
  const value = props[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ProviderError(
      `Neo4j record field "${key}" must be a string or empty (got ${describeType(value)}).`,
    );
  }
  return value;
}

function parsePropertiesBlob(props: Record<string, unknown>): Record<string, unknown> {
  const raw = props['properties'];
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw !== 'string') {
    throw new ProviderError(
      `Neo4j record field "properties" must be a JSON string (got ${describeType(raw)}).`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ProviderError(`Neo4j record field "properties" is not valid JSON: ${detail}.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProviderError(
      `Neo4j record field "properties" must decode to a JSON object (got ${describeType(parsed)}).`,
    );
  }
  return parsed as Record<string, unknown>;
}

function parseRequiredJsonObject<T>(props: Record<string, unknown>, key: string): T {
  const raw = props[key];
  if (typeof raw !== 'string' || raw === '') {
    throw new ProviderError(
      `Neo4j record field "${key}" must be a non-empty JSON string (got ${describeType(raw)}).`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ProviderError(`Neo4j record field "${key}" is not valid JSON: ${detail}.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProviderError(
      `Neo4j record field "${key}" must decode to a JSON object (got ${describeType(parsed)}).`,
    );
  }
  return parsed as T;
}

function parseOptionalJsonObject<T>(props: Record<string, unknown>, key: string): T | undefined {
  const raw = props[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') {
    throw new ProviderError(
      `Neo4j record field "${key}" must be a JSON string (got ${describeType(raw)}).`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ProviderError(`Neo4j record field "${key}" is not valid JSON: ${detail}.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProviderError(
      `Neo4j record field "${key}" must decode to a JSON object (got ${describeType(parsed)}).`,
    );
  }
  return parsed as T;
}

function parseEmbedding(props: Record<string, unknown>): number[] | undefined {
  const raw = props['embedding'];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new ProviderError(
      `Neo4j record field "embedding" must be an array of numbers (got ${describeType(raw)}).`,
    );
  }
  for (const v of raw) {
    if (typeof v !== 'number') {
      throw new ProviderError(
        `Neo4j record field "embedding" must contain only numbers (got ${describeType(v)}).`,
      );
    }
  }
  return raw as number[];
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
