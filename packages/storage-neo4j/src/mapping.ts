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

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * Minimal structural shape compatible with `neo4j-driver`'s `Record` class.
 * Keeping the type local lets the mapper compile without importing the driver,
 * which the isolation grep test forbids outside `Neo4jConnection.ts`.
 */
export interface DriverRecord {
  keys: ReadonlyArray<string>;
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

// ─── Internal helpers ────────────────────────────────────────────────

function extractPropertyBag(record: DriverRecord, alias: string): Record<string, unknown> {
  if (record.keys.includes(alias)) {
    const value = record.get(alias);
    if (isNodeLike(value)) return value.properties;
    if (isRelationshipLike(value)) return value.properties;
  }
  const bag: Record<string, unknown> = {};
  for (const key of record.keys) {
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
