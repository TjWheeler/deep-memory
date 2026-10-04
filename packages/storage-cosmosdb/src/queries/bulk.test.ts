import { describe, expect, it } from 'vitest';
import { ProviderError, RepositoryNotFoundError } from '@utaba/deep-memory';
import type { StoredEntity, StoredRelationship } from '@utaba/deep-memory/types';
import type { CosmosDbConnection, GremlinResult } from '../CosmosDbConnection.js';
import { importBulk, isRowShapedSubmitFailure } from './bulk.js';
import { REPOSITORY_MARKER_COUNT_QUERY } from './marker.js';

const RID = '40000000-0000-4000-a000-00000000b001';

function provenance(): StoredEntity['provenance'] {
  const now = new Date().toISOString();
  return {
    createdBy: 'bulk-test',
    createdByType: 'agent',
    createdAt: now,
    modifiedBy: 'bulk-test',
    modifiedByType: 'agent',
    modifiedAt: now,
  };
}

function entity(id: string, properties: Record<string, unknown> = {}): StoredEntity {
  return { id, slug: `person:${id}`, entityType: 'person', label: id, properties, provenance: provenance() };
}

function relationship(id: string): StoredRelationship {
  return {
    id,
    relationshipType: 'knows',
    sourceEntityId: 'a',
    targetEntityId: 'b',
    properties: {},
    bidirectional: false,
    provenance: provenance(),
  };
}

/** A Gremlin driver ResponseError carrying a Cosmos `x-ms-status-code`. */
function cosmosError(status: number, message: string): Error & { statusAttributes: Record<string, unknown> } {
  return Object.assign(new Error(message), {
    name: 'ResponseError',
    statusCode: 500,
    statusAttributes: { 'x-ms-status-code': status },
  });
}

/**
 * Connection fake: `respond` returns the error a submit should fail with, if
 * any. The repository marker read answers `markerCount` and is counted in
 * `markerReads`, not in `submitted`.
 */
function fakeConnection(
  respond: (bindings: Record<string, unknown>) => Error | undefined,
  items: (bindings: Record<string, unknown>) => unknown[] = () => [{}],
  markerCount = 1,
): {
  conn: CosmosDbConnection;
  submitted: string[];
  markerReads: () => number;
} {
  const submitted: string[] = [];
  let markerReads = 0;
  const fake = {
    async submit(query: string, bindings: Record<string, unknown> = {}): Promise<GremlinResult> {
      if (query === REPOSITORY_MARKER_COUNT_QUERY) {
        markerReads++;
        return { items: [markerCount] };
      }
      const id = String(bindings['vid'] ?? bindings['relId']);
      submitted.push(id);
      const failure = respond(bindings);
      if (failure !== undefined) throw failure;
      return { items: items(bindings) };
    },
  };
  return { conn: fake as unknown as CosmosDbConnection, submitted, markerReads: () => markerReads };
}

describe('importBulk failure handling', () => {
  it('records a duplicate id as a row error with its code and keeps importing', async () => {
    const { conn } = fakeConnection((b) =>
      b['vid'] === 'e2' ? cosmosError(409, 'Resource with specified id or name already exists.') : undefined,
    );

    const result = await importBulk(conn, RID, [{ entities: [entity('e1'), entity('e2'), entity('e3')] }], {
      skipExistenceCheck: true,
    });

    expect(result.entitiesImported).toBe(2);
    expect(result.errors).toEqual([
      { item: 'entity:e2', code: 'ENTITY_ALREADY_EXISTS', error: expect.stringContaining('already exists') },
    ]);
  });

  it('records a relationship conflict with RELATIONSHIP_ALREADY_EXISTS', async () => {
    const { conn } = fakeConnection((b) => (b['relId'] === 'r1' ? cosmosError(409, 'conflict') : undefined));

    const result = await importBulk(conn, RID, [{ relationships: [relationship('r1'), relationship('r2')] }], {
      skipExistenceCheck: true,
    });

    expect(result.relationshipsImported).toBe(1);
    expect(result.errors).toEqual([{ item: 'relationship:r1', code: 'RELATIONSHIP_ALREADY_EXISTS', error: 'Relationship "r1" already exists' }]);
  });

  it('records a row whose properties the mapping refuses, without submitting it', async () => {
    const { conn, submitted } = fakeConnection(() => undefined);

    const result = await importBulk(conn, RID, [{ entities: [entity('e1', { entityType: 'clash' }), entity('e2')] }]);

    expect(submitted).toEqual(['e2']);
    expect(result.entitiesImported).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ item: 'entity:e1', code: 'INVALID_INPUT' });
  });

  it('rejects with a typed error when the container is gone (404) and stops dispatching rows', async () => {
    const gone = cosmosError(404, 'Owner resource does not exist');
    const { conn, submitted } = fakeConnection(() => gone);
    const entities = Array.from({ length: 50 }, (_, i) => entity(`e${i}`));

    const rejection = importBulk(conn, RID, [{ entities }]);
    await expect(rejection).rejects.toBeInstanceOf(ProviderError);
    await expect(rejection).rejects.toMatchObject({ cause: gone });
    // Only the rows already in flight when the first failure landed were tried.
    expect(submitted.length).toBeLessThan(entities.length);
  });

  it('runs a row again after throttling that outlived the connection retries', async () => {
    let throttled = false;
    const { conn, submitted } = fakeConnection((b) => {
      if (b['vid'] === 'e1' && !throttled) {
        throttled = true;
        return cosmosError(429, 'Request rate is large');
      }
      return undefined;
    });

    const result = await importBulk(conn, RID, [{ entities: [entity('e1'), entity('e2')] }], {
      adaptiveConcurrency: { start: 1, min: 1, max: 1, cooldownMs: 0 },
    });

    expect(result).toEqual({ entitiesImported: 2, relationshipsImported: 0, errors: [] });
    expect(submitted.filter((id) => id === 'e1')).toHaveLength(2);
  });

  it('ends sustained throttling with the circuit breaker, not a row error', async () => {
    const { conn } = fakeConnection(() => cosmosError(429, 'Request rate is large'));

    await expect(
      importBulk(conn, RID, [{ entities: [entity('e1'), entity('e2')] }], {
        adaptiveConcurrency: { start: 1, min: 1, max: 1, cooldownMs: 0, maxConsecutiveThrottlesAtMin: 3 },
      }),
    ).rejects.toMatchObject({ name: 'ImportThrottleAbortError' });
  });

  it('records a relationship whose endpoint is missing with ENTITY_NOT_FOUND', async () => {
    const { conn } = fakeConnection(
      () => undefined,
      (b) => (b['relId'] === 'r2' ? [] : [{}]),
    );

    const result = await importBulk(conn, RID, [{ relationships: [relationship('r1'), relationship('r2')] }]);

    expect(result.relationshipsImported).toBe(1);
    expect(result.errors).toEqual([
      { item: 'relationship:r2', code: 'ENTITY_NOT_FOUND', error: 'endpoint not found in repository (source=a, target=b)' },
    ]);
  });

  it('rejects on a failure that carries no Cosmos status (a lost connection)', async () => {
    const lost = new Error('WebSocket is not open: readyState 3 (CLOSED)');
    const { conn } = fakeConnection(() => lost);

    await expect(importBulk(conn, RID, [{ relationships: [relationship('r1')] }])).rejects.toMatchObject({
      name: 'ProviderError',
      cause: lost,
    });
  });
});

describe('importBulk relationship ids', () => {
  /** Captures the statements a relationship import submits, keyed by row id. */
  function capturingConnection(respond: (relId: string, attempt: number) => Error | undefined): {
    conn: CosmosDbConnection;
    queries: Map<string, string[]>;
  } {
    const queries = new Map<string, string[]>();
    const fake = {
      async submit(query: string, bindings: Record<string, unknown> = {}): Promise<GremlinResult> {
        if (query === REPOSITORY_MARKER_COUNT_QUERY) return { items: [1] };
        const relId = String(bindings['relId']);
        const sent = queries.get(relId) ?? [];
        sent.push(query);
        queries.set(relId, sent);
        const failure = respond(relId, sent.length);
        if (failure !== undefined) throw failure;
        return { items: [{}] };
      },
    };
    return { conn: fake as unknown as CosmosDbConnection, queries };
  }

  const conflict = (): Error => cosmosError(409, 'Resource with specified id or name already exists.');

  it('upserts from one lookup of both endpoints and updates only the edge with the row type and endpoints', async () => {
    const { conn, queries } = capturingConnection(() => undefined);

    await importBulk(conn, RID, [{ relationships: [relationship('r1')] }]);

    const query = queries.get('r1')![0]!;
    expect(query).toMatch(
      /^g\.V\(\)\.has\('repositoryId', rid\)\.hasId\(within\(srcId, tgtId\)\)\.has\('entityType'\)\.fold\(\)\.as\('vs'\)/,
    );
    expect(query).toContain(
      ".coalesce(__.outE(edgeLabel).hasId(relId).where(__.inV().hasId(tgtId))",
    );
    expect(query).toContain(", __.addE(edgeLabel).to('t').property('id', relId).property('repositoryId', rid)");
    // No edge scan by id and no lookup after the first step.
    expect(query).not.toContain('g.E()');
    expect(query.match(/[.(]V\(\)/g)).toHaveLength(1);
  });

  it('refuses an upserted row whose id another edge holds with RELATIONSHIP_ALREADY_EXISTS after one resubmit', async () => {
    const { conn, queries } = capturingConnection((relId) => (relId === 'r1' ? conflict() : undefined));

    const result = await importBulk(conn, RID, [{ relationships: [relationship('r1'), relationship('r2')] }]);

    expect(queries.get('r1')).toHaveLength(2);
    expect(queries.get('r2')).toHaveLength(1);
    expect(result.relationshipsImported).toBe(1);
    expect(result.errors).toEqual([
      { item: 'relationship:r1', code: 'RELATIONSHIP_ALREADY_EXISTS', error: 'Relationship "r1" already exists' },
    ]);
  });

  it('imports an upserted row whose resubmit finds the edge an earlier row of the import wrote', async () => {
    const { conn, queries } = capturingConnection((_relId, attempt) => (attempt === 1 ? conflict() : undefined));

    const result = await importBulk(conn, RID, [{ relationships: [relationship('r1')] }]);

    expect(queries.get('r1')).toHaveLength(2);
    expect(result).toMatchObject({ relationshipsImported: 1, errors: [] });
  });

  it('does not resubmit an inserted row the store refuses with a 409', async () => {
    const { conn, queries } = capturingConnection(() => conflict());

    const result = await importBulk(conn, RID, [{ relationships: [relationship('r1')] }], { skipExistenceCheck: true });

    expect(queries.get('r1')).toHaveLength(1);
    expect(result.errors).toEqual([
      { item: 'relationship:r1', code: 'RELATIONSHIP_ALREADY_EXISTS', error: 'Relationship "r1" already exists' },
    ]);
  });

  it('does not resubmit an upserted entity the store refuses with a 409', async () => {
    const queries: string[] = [];
    const fake = {
      async submit(query: string): Promise<GremlinResult> {
        if (query === REPOSITORY_MARKER_COUNT_QUERY) return { items: [1] };
        queries.push(query);
        throw conflict();
      },
    };

    const result = await importBulk(fake as unknown as CosmosDbConnection, RID, [{ entities: [entity('e1')] }]);

    expect(queries).toHaveLength(1);
    expect(result.errors).toEqual([
      { item: 'entity:e1', code: 'ENTITY_ALREADY_EXISTS', error: expect.stringContaining('already exists') },
    ]);
  });
});

describe('importBulk on a missing repository', () => {
  it.each([
    ['upsert', false],
    ['insert', true],
  ])('refuses in %s mode before writing any row', async (_mode, skipExistenceCheck) => {
    const { conn, submitted } = fakeConnection(() => undefined, () => [{}], 0);

    await expect(
      importBulk(conn, RID, [{ entities: [entity('e1')], relationships: [relationship('r1')] }], { skipExistenceCheck }),
    ).rejects.toBeInstanceOf(RepositoryNotFoundError);
    expect(submitted).toEqual([]);
  });

  it('refuses an empty import', async () => {
    const { conn, markerReads } = fakeConnection(() => undefined, () => [{}], 0);

    await expect(importBulk(conn, RID, [])).rejects.toBeInstanceOf(RepositoryNotFoundError);
    expect(markerReads()).toBe(1);
  });

  it('reads the marker once per chunk', async () => {
    const { conn, markerReads } = fakeConnection(() => undefined);

    await importBulk(conn, RID, [{ entities: [entity('e1')] }, { relationships: [relationship('r1')] }, {}]);
    expect(markerReads()).toBe(3);
  });
});

describe('isRowShapedSubmitFailure', () => {
  it('accepts per-document statuses and rejects store statuses', () => {
    for (const status of [400, 409, 413]) {
      expect(isRowShapedSubmitFailure(cosmosError(status, 'x'))).toBe(true);
    }
    for (const status of [404, 408, 429, 449, 500, 503, 401, 403]) {
      expect(isRowShapedSubmitFailure(cosmosError(status, 'x'))).toBe(false);
    }
    expect(isRowShapedSubmitFailure(new Error('socket hang up'))).toBe(false);
  });
});
