import { describe, expect, it } from 'vitest';
import {
  DuplicateEntityError,
  InvalidInputError,
  ProviderError,
  RepositoryNotFoundError,
  SlugConflictError,
} from '@utaba/deep-memory';
import type { StoredEntity } from '@utaba/deep-memory/types';
import type { Neo4jConnection } from '../Neo4jConnection.js';
import {
  buildFindEntitiesWhere,
  buildFulltextFindQuery,
  createEntity,
  escapeLuceneQuery,
  resolveSearchScoring,
  updateEntity,
  type Neo4jSearchScoring,
} from './entity.js';

describe('buildFindEntitiesWhere', () => {
  it('returns an empty WHERE fragment when only the repository predicate is requested with no filters', () => {
    const result = buildFindEntitiesWhere(
      { limit: 10, offset: 0 },
      { alias: 'n', includeRepositoryPredicate: true },
    );
    expect(result.cypherWhere).toBe('WHERE n.repositoryId = $rid');
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
      'WHERE n.repositoryId = $rid AND n.entityType IN $entityTypes',
    );
    expect(result.params).toEqual({ entityTypes: ['Person', 'Place'] });
  });

  it('emits one server-side equality predicate per user-supplied property against the native scalar', () => {
    const result = buildFindEntitiesWhere(
      { properties: { city: 'Berlin', age: 30 }, limit: 10, offset: 0 },
      { alias: 'n', includeRepositoryPredicate: true },
    );
    expect(result.cypherWhere).toBe(
      'WHERE n.repositoryId = $rid AND n.city = $prop0 AND n.age = $prop1',
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
    ).toThrowError(ProviderError);
  });

  it('rejects user-property keys that collide with reserved schema field names', () => {
    expect(() =>
      buildFindEntitiesWhere(
        { properties: { entityType: 'Person' }, limit: 10, offset: 0 },
        { alias: 'n', includeRepositoryPredicate: true },
      ),
    ).toThrowError(ProviderError);
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
