import { describe, expect, it } from 'vitest';
import { ProviderError } from '@utaba/deep-memory';
import { buildFindEntitiesWhere, escapeLuceneQuery } from './entity.js';

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
