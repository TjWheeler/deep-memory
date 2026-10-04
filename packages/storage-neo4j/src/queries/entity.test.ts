import { describe, expect, it } from 'vitest';
import {
  DeepMemoryError,
  DuplicateEntityError,
  InvalidInputError,
  ProviderError,
  RepositoryNotFoundError,
  SlugConflictError,
} from '@utaba/deep-memory';
import type { StoredEntity } from '@utaba/deep-memory/types';
import type { Neo4jConnection } from '../Neo4jConnection.js';
import { batchConnection } from './batchConnection.test-support.js';
import {
  buildFindEntitiesWhere,
  buildFulltextFindQuery,
  createEntity,
  deleteEntitiesByType,
  ENTITY_DELETE_BY_TYPE_QUERY,
  findEntities,
  escapeLuceneQuery,
  resolveSearchScoring,
  updateEntity,
  type Neo4jSearchScoring,
} from './entity.js';

describe('buildFindEntitiesWhere', () => {
  it('returns only the repository predicates when no filters are requested', () => {
    const result = buildFindEntitiesWhere(
      { limit: 10, offset: 0 },
      { alias: 'n', includeRepositoryPredicate: true },
    );
    expect(result.cypherWhere).toBe('WHERE n.repositoryId = $rid AND n.id IS NOT NULL');
    expect(result.params).toEqual({});
  });

  it('omits the repository predicate when the caller will emit it inline (fulltext branch)', () => {
    const result = buildFindEntitiesWhere(
      { limit: 10, offset: 0 },
      { alias: 'node', includeRepositoryPredicate: false },
    );
    expect(result.cypherWhere).toBe('');
    expect(result.params).toEqual({});
  });

  it('emits an IN predicate plus a single parameter binding for entityTypes', () => {
    const result = buildFindEntitiesWhere(
      { entityTypes: ['Person', 'Place'], limit: 10, offset: 0 },
      { alias: 'n', includeRepositoryPredicate: true },
    );
    expect(result.cypherWhere).toBe(
      'WHERE n.repositoryId = $rid AND n.id IS NOT NULL AND n.entityType IN $entityTypes',
    );
    expect(result.params).toEqual({ entityTypes: ['Person', 'Place'] });
  });

  it('emits one server-side equality predicate per user-supplied property against the native scalar', () => {
    const result = buildFindEntitiesWhere(
      { properties: { city: 'Berlin', age: 30 }, limit: 10, offset: 0 },
      { alias: 'n', includeRepositoryPredicate: true },
    );
    expect(result.cypherWhere).toBe(
      'WHERE n.repositoryId = $rid AND n.id IS NOT NULL AND n.city = $prop0 AND n.age = $prop1',
    );
    expect(result.params['prop0']).toBe('Berlin');
    expect(result.params['prop1']).toBe(30);
  });

  it('rejects user-property keys that are not bare Cypher identifiers', () => {
    expect(() =>
      buildFindEntitiesWhere(
        { properties: { 'has-dash': 'x' }, limit: 10, offset: 0 },
        { alias: 'n', includeRepositoryPredicate: true },
      ),
    ).toThrowError(InvalidInputError);
  });

  it('rejects user-property keys that collide with reserved schema field names', () => {
    expect(() =>
      buildFindEntitiesWhere(
        { properties: { entityType: 'Person' }, limit: 10, offset: 0 },
        { alias: 'n', includeRepositoryPredicate: true },
      ),
    ).toThrowError(InvalidInputError);
  });

  it('rejects property-filter values that Neo4j cannot store as a native scalar', () => {
    expect(() =>
      buildFindEntitiesWhere(
        { properties: { nested: { foo: 'bar' } }, limit: 10, offset: 0 },
        { alias: 'n', includeRepositoryPredicate: true },
      ),
    ).toThrowError(ProviderError);
    expect(() =>
      buildFindEntitiesWhere(
        { properties: { missing: null }, limit: 10, offset: 0 },
        { alias: 'n', includeRepositoryPredicate: true },
      ),
    ).toThrowError(ProviderError);
  });

  it('emits the OR-of-created/modified predicates for provenance.conversationIds', () => {
    const result = buildFindEntitiesWhere(
      {
        provenance: { conversationIds: ['conv-1', 'conv-2'] },
        limit: 10,
        offset: 0,
      },
      { alias: 'n', includeRepositoryPredicate: true },
    );
    expect(result.cypherWhere).toContain(
      '(n.createdInConversation IN $convIds OR n.modifiedInConversation IN $convIds)',
    );
    expect(result.params).toEqual({ convIds: ['conv-1', 'conv-2'] });
  });

  it('emits the OR-of-creator/modifier predicate for provenance.actors', () => {
    const result = buildFindEntitiesWhere(
      { provenance: { actors: ['alice'] }, limit: 10, offset: 0 },
      { alias: 'n', includeRepositoryPredicate: true },
    );
    expect(result.cypherWhere).toContain(
      '(n.createdBy IN $actors OR n.modifiedBy IN $actors)',
    );
    expect(result.params).toEqual({ actors: ['alice'] });
  });

  it('emits a range predicate spanning both createdAt and modifiedAt for provenance.dateRange', () => {
    const result = buildFindEntitiesWhere(
      {
        provenance: {
          dateRange: {
            from: '2026-01-01T00:00:00.000Z',
            to: '2026-01-31T23:59:59.999Z',
          },
        },
        limit: 10,
        offset: 0,
      },
      { alias: 'n', includeRepositoryPredicate: true },
    );
    expect(result.cypherWhere).toContain('n.createdAt >= $dateFrom');
    expect(result.cypherWhere).toContain('n.createdAt <= $dateTo');
    expect(result.cypherWhere).toContain('n.modifiedAt >= $dateFrom');
    expect(result.cypherWhere).toContain('n.modifiedAt <= $dateTo');
    expect(result.params).toEqual({
      dateFrom: '2026-01-01T00:00:00.000Z',
      dateTo: '2026-01-31T23:59:59.999Z',
    });
  });

  it('uses the supplied alias in every predicate fragment', () => {
    const result = buildFindEntitiesWhere(
      {
        entityTypes: ['Person'],
        properties: { city: 'Berlin' },
        provenance: { actors: ['alice'] },
        limit: 10,
        offset: 0,
      },
      { alias: 'node', includeRepositoryPredicate: false },
    );
    expect(result.cypherWhere).not.toContain('n.');
    expect(result.cypherWhere).toContain('node.entityType');
    expect(result.cypherWhere).toContain('node.city = $prop0');
    expect(result.cypherWhere).toContain('node.createdBy IN');
  });
});

describe('escapeLuceneQuery', () => {
  // Guards the fulltext branch of findEntities against the class of caller text
  // that made `db.index.fulltext.queryNodes` throw ParseException: unbalanced
  // range brackets, stray quotes, colons, and boolean-operator characters bound
  // verbatim as a Lucene query.
  it('escapes an unbalanced range bracket that would open a Lucene range query', () => {
    expect(escapeLuceneQuery('ai-services [Services]')).toBe('ai\\-services \\[Services\\]');
  });

  it('escapes every reserved metacharacter in the classic-query set', () => {
    const reserved = '+-&|!(){}[]^"~*?:\\/';
    const escaped = escapeLuceneQuery(reserved);
    // Each reserved character is preceded by exactly one backslash.
    expect(escaped).toBe('\\+\\-\\&\\|\\!\\(\\)\\{\\}\\[\\]\\^\\"\\~\\*\\?\\:\\\\\\/');
  });

  it('escapes a bare backslash so it cannot pair with a following character', () => {
    expect(escapeLuceneQuery('a\\b')).toBe('a\\\\b');
  });

  it('preserves plain words and whitespace untouched so relevance is unaffected', () => {
    expect(escapeLuceneQuery('morning brief agenda')).toBe('morning brief agenda');
  });

  it('leaves unicode and emoji terms intact', () => {
    expect(escapeLuceneQuery('café 日本語 🚀')).toBe('café 日本語 🚀');
  });

  it('escapes the individual & and | that form && and || operators', () => {
    expect(escapeLuceneQuery('a && b || c')).toBe('a \\&\\& b \\|\\| c');
  });

  it('returns an empty string unchanged', () => {
    expect(escapeLuceneQuery('')).toBe('');
  });
});

describe('updateEntity error mapping', () => {
  const CONSTRAINT_VIOLATION = 'Neo.ClientError.Schema.ConstraintValidationFailed';
  const provenance = {
    createdBy: 't',
    createdByType: 'agent' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedBy: 't',
    modifiedByType: 'agent' as const,
    modifiedAt: '2026-01-01T00:00:00.000Z',
  };

  function failingConnection(error: unknown): Neo4jConnection {
    const fake = {
      async executeQuery(): Promise<never> {
        throw error;
      },
    };
    return fake as unknown as Neo4jConnection;
  }

  it('maps a slug-constraint violation on a slug change to SlugConflictError with cause', async () => {
    const driverError = Object.assign(
      new Error(
        "Node(7) already exists with label `_Entity` and properties `repositoryId` = 'r1', `slug` = 'person:sam'",
      ),
      { code: CONSTRAINT_VIOLATION },
    );

    const rejection = updateEntity(failingConnection(driverError), 'r1', 'e1', {
      label: 'Sam',
      slug: 'person:sam',
      provenance,
    });

    await expect(rejection).rejects.toBeInstanceOf(SlugConflictError);
    await expect(rejection).rejects.toMatchObject({ slug: 'person:sam', label: 'Sam', cause: driverError });
  });

  it('reports a violation it cannot identify as ProviderError rather than guessing', async () => {
    const driverError = Object.assign(new Error('Node(7) already exists'), { code: CONSTRAINT_VIOLATION });

    const rejection = updateEntity(failingConnection(driverError), 'r1', 'e1', {
      slug: 'person:sam',
      provenance,
    });

    await expect(rejection).rejects.toBeInstanceOf(ProviderError);
    await expect(rejection).rejects.toMatchObject({ cause: driverError });
  });
});

describe('createEntity error mapping', () => {
  const now = '2026-01-01T00:00:00.000Z';
  const entity: StoredEntity = {
    id: 'e1',
    slug: 'Thing:e1',
    entityType: 'Thing',
    label: 'e1',
    summary: '',
    properties: {},
    provenance: {
      createdBy: 't',
      createdByType: 'agent',
      createdAt: now,
      modifiedBy: 't',
      modifiedByType: 'agent',
      modifiedAt: now,
    },
  };

  function failingConnection(error: unknown): { conn: Neo4jConnection; calls: () => number } {
    let count = 0;
    const fake = {
      async executeQuery(): Promise<never> {
        count++;
        throw error;
      },
    };
    return { conn: fake as unknown as Neo4jConnection, calls: () => count };
  }

  it('maps a deleted repository marker to RepositoryNotFoundError without a follow-up read', async () => {
    const driverError = Object.assign(new Error('Node with id 3 has been deleted in this transaction'), {
      code: 'Neo.ClientError.Statement.EntityNotFound',
    });
    const { conn, calls } = failingConnection(driverError);

    await expect(createEntity(conn, 'r1', entity)).rejects.toBeInstanceOf(RepositoryNotFoundError);
    await expect(createEntity(conn, 'r1', entity)).rejects.toMatchObject({ repositoryId: 'r1' });
    expect(calls()).toBe(2);
  });

  it('maps any other driver error as before', async () => {
    const driverError = Object.assign(new Error('boom'), { code: 'Neo.DatabaseError.General.UnknownError' });

    await expect(createEntity(failingConnection(driverError).conn, 'r1', entity)).rejects.toMatchObject({
      name: 'ProviderError',
      cause: driverError,
    });
  });
});

describe('createEntity under a driver re-run', () => {
  const now = '2026-01-01T00:00:00.000Z';
  const CONSTRAINT_VIOLATION = 'Neo.ClientError.Schema.ConstraintValidationFailed';

  function entity(overrides: Partial<StoredEntity> = {}): StoredEntity {
    return {
      id: 'e1',
      slug: 'Thing:e1',
      entityType: 'Thing',
      label: 'e1',
      summary: '',
      properties: {},
      provenance: {
        createdBy: 't',
        createdByType: 'agent',
        createdAt: now,
        modifiedBy: 't',
        modifiedByType: 'agent',
        modifiedAt: now,
      },
      ...overrides,
    };
  }

  interface StoredNode {
    slug: string;
    writeAttempt: string | null;
  }

  function violation(key: 'id' | 'slug', value: string): Error & { code: string } {
    return Object.assign(
      new Error(`Node(9) already exists with label \`_Entity\` and properties \`repositoryId\` = 'r1', \`${key}\` = '${value}'`),
      { code: CONSTRAINT_VIOLATION },
    );
  }

  /**
   * A connection fake over an in-memory set of entity nodes. Its create
   * statement enforces the id and slug constraints in `checkOrder`. With
   * `ackLost`, the driver commits the first run, loses the acknowledgement
   * and runs the statement again, answering with the second run's outcome
   * — the shape `driver.executeQuery`'s managed retry gives the caller.
   */
  function entityStore(options: {
    seed?: Array<[string, StoredNode]>;
    ackLost: boolean;
    checkOrder?: Array<'id' | 'slug'>;
  }) {
    const nodes = new Map<string, StoredNode>(options.seed ?? []);
    const checkOrder = options.checkOrder ?? ['id', 'slug'];
    const statements: Array<{ cypher: string; params: Record<string, unknown> }> = [];

    const runCreate = (params: Record<string, unknown>) => {
      const id = params['id'] as string;
      const slug = params['slug'] as string;
      for (const key of checkOrder) {
        if (key === 'id' && nodes.has(id)) throw violation('id', id);
        if (key === 'slug' && Array.from(nodes.values()).some((n) => n.slug === slug)) throw violation('slug', slug);
      }
      nodes.set(id, { slug, writeAttempt: params['writeAttempt'] as string });
      return {
        records: [{ get: (key: string) => (key === 'id' ? id : undefined) }],
        summary: { counters: { updates: () => ({ nodesCreated: 1 }) } },
      };
    };

    const fake = {
      async executeQuery(cypher: string, params: Record<string, unknown>) {
        statements.push({ cypher, params });
        if (cypher.includes('CREATE (n:_Entity')) {
          if (options.ackLost) runCreate(params);
          return runCreate(params);
        }
        if (cypher.includes('AS writeAttempt')) {
          const node = nodes.get(params['id'] as string);
          return {
            records: node === undefined ? [] : [{ get: (key: string) => (key === 'writeAttempt' ? node.writeAttempt : undefined) }],
          };
        }
        throw new Error(`unexpected statement: ${cypher}`);
      },
    };
    return { conn: fake as unknown as Neo4jConnection, nodes, statements };
  }

  it('writes a fresh write token with every create', async () => {
    const { conn, nodes, statements } = entityStore({ ackLost: false });

    await createEntity(conn, 'r1', entity());
    await createEntity(conn, 'r1', entity({ id: 'e2', slug: 'Thing:e2' }));

    const [first, second] = statements;
    expect(first!.cypher).toContain('_attempt: $writeAttempt');
    expect(first!.params['writeAttempt']).toMatch(/^[0-9a-f-]{36}$/);
    expect(first!.params['writeAttempt']).not.toBe(second!.params['writeAttempt']);
    expect(nodes.get('e1')!.writeAttempt).toBe(first!.params['writeAttempt']);
  });

  it('reports success when the re-run trips the id constraint on its own committed entity', async () => {
    const created = entity();
    const { conn, nodes } = entityStore({ ackLost: true, checkOrder: ['id', 'slug'] });

    await expect(createEntity(conn, 'r1', created)).resolves.toBe(created);
    expect(nodes.size).toBe(1);
  });

  it('reports success when the re-run trips the slug constraint first on its own committed entity', async () => {
    const created = entity();
    const { conn, nodes } = entityStore({ ackLost: true, checkOrder: ['slug', 'id'] });

    await expect(createEntity(conn, 'r1', created)).resolves.toBe(created);
    expect(nodes.size).toBe(1);
  });

  it('still throws DuplicateEntityError for an id another call created', async () => {
    const { conn } = entityStore({ ackLost: false, seed: [['e1', { slug: 'Thing:other', writeAttempt: 'another-call' }]] });

    await expect(createEntity(conn, 'r1', entity())).rejects.toBeInstanceOf(DuplicateEntityError);
  });

  it('still throws DuplicateEntityError for an id an import wrote without a token', async () => {
    const { conn } = entityStore({ ackLost: false, seed: [['e1', { slug: 'Thing:other', writeAttempt: null }]] });

    await expect(createEntity(conn, 'r1', entity())).rejects.toBeInstanceOf(DuplicateEntityError);
  });

  it('still throws SlugConflictError for a slug another entity holds', async () => {
    const { conn } = entityStore({ ackLost: false, seed: [['e0', { slug: 'Thing:e1', writeAttempt: 'another-call' }]] });

    const rejection = createEntity(conn, 'r1', entity());
    await expect(rejection).rejects.toBeInstanceOf(SlugConflictError);
    await expect(rejection).rejects.toMatchObject({ slug: 'Thing:e1' });
  });

  it('reports a failed token read-back as ProviderError rather than guessing', async () => {
    const readFailure = Object.assign(new Error('connection reset'), { code: 'ServiceUnavailable' });
    const fake = {
      async executeQuery(cypher: string) {
        if (cypher.includes('CREATE (n:_Entity')) throw violation('id', 'e1');
        throw readFailure;
      },
    };

    await expect(createEntity(fake as unknown as Neo4jConnection, 'r1', entity())).rejects.toMatchObject({
      name: 'ProviderError',
      cause: readFailure,
    });
  });
});

describe('search scoring modes', () => {
  // An untyped host config can carry any string.
  const untyped: string = 'score';

  it('resolves an unset mode to relevance and keeps each documented mode', () => {
    expect(resolveSearchScoring(undefined)).toBe('relevance');
    expect(resolveSearchScoring('relevance')).toBe('relevance');
    expect(resolveSearchScoring('isolated')).toBe('isolated');
  });

  it('refuses any other mode', () => {
    expect(() => resolveSearchScoring(untyped as Neo4jSearchScoring)).toThrow(InvalidInputError);
  });

  it('orders by score for relevance and by label, id for isolated', () => {
    expect(buildFulltextFindQuery('relevance', 'WHERE node.repositoryId = $rid', 'node')).toContain('ORDER BY score DESC');
    const isolated = buildFulltextFindQuery('isolated', 'WHERE node.repositoryId = $rid', 'node');
    expect(isolated).toContain('ORDER BY node.label, node.id');
    expect(isolated).not.toContain('score');
  });

  it('builds no statement for any other mode', () => {
    expect(() => buildFulltextFindQuery(untyped as Neo4jSearchScoring, 'WHERE node.repositoryId = $rid', 'node')).toThrow(
      InvalidInputError,
    );
  });
});

/** A driver error the mapping does not recognise. */
const DRIVER_FAILURE = Object.assign(new Error('database unavailable'), { code: 'Neo.DatabaseError.General.UnknownError' });

/** A connection whose statements answer one row each through `answer`, or reject with what it throws. */
function answeringConnection(answer: (cypher: string) => Record<string, unknown> | undefined): Neo4jConnection {
  return {
    executeQuery: async (cypher: string) => {
      const row = answer(cypher);
      return { records: row === undefined ? [] : [{ get: (key: string) => row[key] }] };
    },
  } as unknown as Neo4jConnection;
}

describe('findEntities on a failing page', () => {
  /** The count statement, which also reads the repository marker. */
  const isCount = (cypher: string): boolean => cypher.includes('AS repositoryExists');
  const cases: Array<[string, string | undefined]> = [
    ['without a search term', undefined],
    ['with a search term', 'alpha'],
  ];

  it.each(cases)('reports a missing repository ahead of a failed page %s', async (_name, searchTerm) => {
    const conn = answeringConnection((cypher) => {
      if (isCount(cypher)) return { repositoryExists: false, total: 0n };
      throw DRIVER_FAILURE;
    });

    await expect(
      findEntities(conn, 'repo-find', { limit: 10, offset: 0, ...(searchTerm ? { searchTerm } : {}) }, undefined, 'relevance'),
    ).rejects.toBeInstanceOf(RepositoryNotFoundError);
  });

  it('raises a failed page as a typed error once the marker is found', async () => {
    const conn = answeringConnection((cypher) => {
      if (isCount(cypher)) return { repositoryExists: true, total: 1n };
      throw DRIVER_FAILURE;
    });

    const thrown: unknown = await findEntities(conn, 'repo-find', { limit: 10, offset: 0 }, undefined, 'relevance').catch(
      (err: unknown) => err,
    );
    expect(thrown).toBeInstanceOf(DeepMemoryError);
    expect((thrown as Error).cause).toBe(DRIVER_FAILURE);
  });
});

describe('deleteEntitiesByType in batches', () => {
  const RID = 'repo-by-type';
  const BATCHING = { batchSize: 2, edgeCap: 3 };

  it('runs batches until one finds fewer than the batch size, and sums their counters', async () => {
    const { conn, calls } = batchConnection(RID, [
      { row: { repositoryExists: true, edges: 2n, entities: 2n }, counters: { nodesDeleted: 2, relationshipsDeleted: 2 } },
      { row: { repositoryExists: true, edges: 1n, entities: 2n }, counters: { nodesDeleted: 2, relationshipsDeleted: 1 } },
      { row: { repositoryExists: true, edges: 0n, entities: 1n }, counters: { nodesDeleted: 1 } },
    ]);

    const result = await deleteEntitiesByType(conn, RID, 'person', BATCHING);

    expect(result).toEqual({ deletedEntities: 5, deletedRelationships: 3 });
    expect(calls).toHaveLength(3);
    expect(calls[0]?.params).toEqual({ entityType: 'person', batchSize: 2n, edgeCap: 3n });
  });

  it('runs again while a batch reaches the edge cap, then deletes the entities', async () => {
    const { conn, calls } = batchConnection(RID, [
      { row: { repositoryExists: true, edges: 3n, entities: 0n }, counters: { relationshipsDeleted: 3 } },
      { row: { repositoryExists: true, edges: 3n, entities: 0n }, counters: { relationshipsDeleted: 3 } },
      { row: { repositoryExists: true, edges: 1n, entities: 1n }, counters: { nodesDeleted: 1, relationshipsDeleted: 1 } },
    ]);

    expect(await deleteEntitiesByType(conn, RID, 'person', BATCHING)).toEqual({
      deletedEntities: 1,
      deletedRelationships: 7,
    });
    expect(calls).toHaveLength(3);
  });

  it('reports 0 when nothing of the type is left', async () => {
    const { conn, calls } = batchConnection(RID, [{ row: { repositoryExists: true, edges: 0n, entities: 0n } }]);
    expect(await deleteEntitiesByType(conn, RID, 'person', BATCHING)).toEqual({
      deletedEntities: 0,
      deletedRelationships: 0,
    });
    expect(calls).toHaveLength(1);
  });

  it('throws RepositoryNotFoundError from the first batch when the marker is missing', async () => {
    const { conn, calls } = batchConnection(RID, [{ row: { repositoryExists: false, edges: 0n, entities: 0n } }]);
    await expect(deleteEntitiesByType(conn, RID, 'person', BATCHING)).rejects.toBeInstanceOf(RepositoryNotFoundError);
    expect(calls).toHaveLength(1);
  });

  it('throws RepositoryNotFoundError when the repository is deleted between batches', async () => {
    const { conn } = batchConnection(RID, [
      { row: { repositoryExists: true, edges: 0n, entities: 2n }, counters: { nodesDeleted: 2 } },
      { row: { repositoryExists: false, edges: 0n, entities: 0n } },
    ]);
    await expect(deleteEntitiesByType(conn, RID, 'person', BATCHING)).rejects.toBeInstanceOf(RepositoryNotFoundError);
  });

  it('runs a batch again after a transient failure, keeping the counts exact', async () => {
    const deadlock = Object.assign(new Error('deadlock'), { code: 'Neo.TransientError.Transaction.DeadlockDetected' });
    const { conn, calls } = batchConnection(RID, [
      { row: { repositoryExists: true, edges: 1n, entities: 2n }, counters: { nodesDeleted: 2, relationshipsDeleted: 1 } },
      { error: deadlock },
      { error: deadlock },
      { row: { repositoryExists: true, edges: 0n, entities: 1n }, counters: { nodesDeleted: 1 } },
    ]);

    expect(await deleteEntitiesByType(conn, RID, 'person', BATCHING)).toEqual({
      deletedEntities: 3,
      deletedRelationships: 1,
    });
    expect(calls).toHaveLength(4);
    expect(calls[3]?.params).toEqual(calls[1]?.params);
  });

  it('raises a transient failure that outlasts the retries as a typed error', async () => {
    const deadlock = Object.assign(new Error('deadlock'), { code: 'Neo.TransientError.Transaction.DeadlockDetected' });
    const { conn, calls } = batchConnection(RID, [{ error: deadlock }, { error: deadlock }, { error: deadlock }, { error: deadlock }]);
    const thrown: unknown = await deleteEntitiesByType(conn, RID, 'person', BATCHING).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(DeepMemoryError);
    expect((thrown as Error).cause).toBe(deadlock);
    expect(calls).toHaveLength(4);
  });

  it('does not run a batch again after a memory-limit failure', async () => {
    const memory = Object.assign(new Error('memory'), { code: 'Neo.TransientError.General.TransactionMemoryLimit' });
    const { conn, calls } = batchConnection(RID, [{ error: memory }]);
    const thrown: unknown = await deleteEntitiesByType(conn, RID, 'person', BATCHING).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(DeepMemoryError);
    expect((thrown as Error).cause).toBe(memory);
    expect(calls).toHaveLength(1);
  });

  it('raises a failed batch as a typed error', async () => {
    const failure = Object.assign(new Error('database unavailable'), { code: 'Neo.DatabaseError.General.UnknownError' });
    const { conn, calls } = batchConnection(RID, [{ error: failure }]);
    const thrown: unknown = await deleteEntitiesByType(conn, RID, 'person', BATCHING).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(DeepMemoryError);
    expect((thrown as Error).cause).toBe(failure);
    expect(calls).toHaveLength(1);
  });

  it('reports a batch with no row as ProviderError', async () => {
    const { conn } = batchConnection(RID, [{}]);
    await expect(deleteEntitiesByType(conn, RID, 'person', BATCHING)).rejects.toBeInstanceOf(ProviderError);
  });

  it('takes the edges up to the cap and deletes the entities only below it', () => {
    expect(ENTITY_DELETE_BY_TYPE_QUERY).toContain('WHERE repo IS NOT NULL');
    expect(ENTITY_DELETE_BY_TYPE_QUERY).toContain('WITH DISTINCT r LIMIT $edgeCap');
    expect(ENTITY_DELETE_BY_TYPE_QUERY).toContain('CASE WHEN edgeCount < $edgeCap THEN batch ELSE [] END AS doomed');
    expect(ENTITY_DELETE_BY_TYPE_QUERY).toContain('FOREACH (n IN doomed | DETACH DELETE n)');
  });
});

describe('updateEntity with stored keys the property-name rules refuse', () => {
  const provenance = {
    createdBy: 't',
    createdByType: 'agent' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedBy: 't',
    modifiedByType: 'agent' as const,
    modifiedAt: '2026-01-01T00:00:00.000Z',
  };

  /**
   * A connection over one stored entity node. `blob` is its JSON user
   * properties and `native` the user properties it also holds as node
   * properties. The pre-read answers the node's properties; the write is
   * recorded and answers the node as the write leaves it.
   */
  function nodeConnection(blob: Record<string, unknown>, native: Record<string, unknown> = {}) {
    const node: Record<string, unknown> = {
      id: 'e1',
      entityType: 'test-type',
      label: 'System label',
      slug: 'test-type:system-label',
      properties: JSON.stringify(blob),
      ...provenance,
      ...native,
    };
    const writes: Array<{ cypher: string; params: Record<string, unknown> }> = [];
    const conn = {
      async executeQuery(cypher: string, params: Record<string, unknown>) {
        if (cypher.includes('properties(n) AS props')) {
          const row: Record<string, unknown> = { repositoryExists: true, props: { ...node } };
          return { records: [{ keys: Object.keys(row), get: (key: string) => row[key] }] };
        }
        writes.push({ cypher, params });
        const after: Record<string, unknown> = { ...node, ...(params['userProperties'] as Record<string, unknown>) };
        if (typeof params['properties'] === 'string') after['properties'] = params['properties'];
        const row: Record<string, unknown> = { repositoryExists: true, entityFound: true, ...after };
        return { records: [{ keys: Object.keys(row), get: (key: string) => row[key] }] };
      },
    };
    return { conn: conn as unknown as Neo4jConnection, writes };
  }

  /** The SET / REMOVE part of an update statement, ahead of its projection. */
  function writeClauses(cypher: string | undefined): string {
    return (cypher ?? '').split(' RETURN ')[0] ?? '';
  }

  it('carries over an unchanged invalid key while another key changes, keeping it out of the query text', async () => {
    const { conn, writes } = nodeConnection({ 'start-date': '2020', ok: 1 }, { ok: 1 });

    const updated = await updateEntity(conn, 'r1', 'e1', {
      properties: { 'start-date': '2020', ok: 2 },
      provenance,
    });

    expect(updated.properties).toEqual({ 'start-date': '2020', ok: 2 });
    const [write] = writes;
    expect(write?.params['userProperties']).toEqual({ ok: 2 });
    expect(write?.cypher).not.toContain('start-date');
    expect(JSON.parse(write?.params['properties'] as string)).toEqual({ 'start-date': '2020', ok: 2 });
  });

  it('carries over an unchanged reserved key in the blob without touching the system field', async () => {
    const { conn, writes } = nodeConnection({ label: 'user value', ok: 1 }, { ok: 1 });

    const updated = await updateEntity(conn, 'r1', 'e1', { properties: { label: 'user value', ok: 2 }, provenance });

    expect(updated.label).toBe('System label');
    expect(updated.properties).toEqual({ label: 'user value', ok: 2 });
    const [write] = writes;
    expect(write?.params['userProperties']).toEqual({ ok: 2 });
    expect(writeClauses(write?.cypher)).not.toContain('n.label');
  });

  it('removes stored invalid and reserved keys the merged map drops, leaving system fields alone', async () => {
    const { conn, writes } = nodeConnection(
      { 'start-date': '2020', label: 'user value', ok: 1, old: 'x' },
      { ok: 1, old: 'x' },
    );

    const updated = await updateEntity(conn, 'r1', 'e1', { properties: { ok: 1 }, provenance });

    expect(updated.label).toBe('System label');
    expect(updated.properties).toEqual({ ok: 1 });
    const [write] = writes;
    expect(write?.cypher).not.toContain('start-date');
    expect(writeClauses(write?.cypher)).toContain('REMOVE n.old');
    expect(writeClauses(write?.cypher)).not.toContain('n.label');
    expect(write?.params['userProperties']).toEqual({ ok: 1 });
  });

  it.each([
    ['a new invalid key', { ok: 1 }, { ok: 1, 'start-date': '2020' }, 'properties.start-date'],
    ['a new reserved key', { ok: 1 }, { ok: 1, createdBy: 'someone' }, 'properties.createdBy'],
    ['a new value for a stored invalid key', { 'start-date': '2020' }, { 'start-date': '2021' }, 'properties.start-date'],
  ])('refuses %s with INVALID_INPUT and writes nothing', async (_what, blob, properties, field) => {
    const { conn, writes } = nodeConnection(blob);

    const rejection = updateEntity(conn, 'r1', 'e1', { properties, provenance });

    await expect(rejection).rejects.toBeInstanceOf(InvalidInputError);
    await expect(rejection).rejects.toMatchObject({ code: 'INVALID_INPUT', field });
    expect(writes).toHaveLength(0);
  });
});
