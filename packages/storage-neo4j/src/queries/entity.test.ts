import { describe, expect, it } from 'vitest';
import { ProviderError, RepositoryNotFoundError, SlugConflictError } from '@utaba/deep-memory';
import type { StoredEntity } from '@utaba/deep-memory/types';
import type { Neo4jConnection } from '../Neo4jConnection.js';
import { buildFindEntitiesWhere, createEntity, escapeLuceneQuery, updateEntity } from './entity.js';

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
