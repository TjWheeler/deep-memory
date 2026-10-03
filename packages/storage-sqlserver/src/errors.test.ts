import { describe, expect, it } from 'vitest';
import {
  DuplicateEntityError,
  DuplicateRelationshipError,
  DuplicateRepositoryError,
  ImportError,
  ProviderError,
  SlugConflictError,
} from '@utaba/deep-memory';
import { importFailure, mapUniqueViolation, readUniqueViolation, UNIQUE_KEYS_BY_TABLE } from './errors.js';
import { getSchemaSQL } from './schema.js';

/** Mirror of the `mssql` RequestError surface: `number` and `message` copied from the server. */
function sqlError(number: number, message: string): Error & { number: number } {
  return Object.assign(new Error(message), { name: 'RequestError', number });
}

const SLUG_INDEX_VIOLATION = sqlError(
  2601,
  "Cannot insert duplicate key row in object 'dbo.dm_entities' with unique index 'ix_dm_entities_slug'. The duplicate key value is (0e0f…, person:alex).",
);
const ENTITY_PK_VIOLATION = sqlError(
  2627,
  "Violation of PRIMARY KEY constraint 'pk_dm_entities'. Cannot insert duplicate key in object 'dbo.dm_entities'. The duplicate key value is (0e0f…, e1).",
);
const RELATIONSHIP_PK_VIOLATION = sqlError(
  2627,
  "Violation of PRIMARY KEY constraint 'pk_dm_relationships'. Cannot insert duplicate key in object 'dbo.dm_relationships'. The duplicate key value is (0e0f…, r1).",
);
const REPOSITORY_PK_VIOLATION = sqlError(
  2627,
  "Violation of PRIMARY KEY constraint 'pk_dm_repositories'. Cannot insert duplicate key in object 'dbo.dm_repositories'. The duplicate key value is (0e0f…).",
);

const ENTITY = {
  kind: 'entity' as const,
  entityId: 'e1',
  slug: 'person:alex',
  entityType: 'person',
  label: 'Alex',
};

describe('readUniqueViolation', () => {
  it('reads the number and the index or constraint name from 2601 and 2627 errors', () => {
    expect(readUniqueViolation(SLUG_INDEX_VIOLATION)).toEqual({ number: 2601, key: 'ix_dm_entities_slug' });
    expect(readUniqueViolation(ENTITY_PK_VIOLATION)).toEqual({ number: 2627, key: 'pk_dm_entities' });
  });

  it('reads the server info when the number is only on originalError', () => {
    const wrapped = {
      message: 'wrapped',
      originalError: { info: { number: 2601, message: SLUG_INDEX_VIOLATION.message } },
    };
    expect(readUniqueViolation(wrapped)).toEqual({ number: 2601, key: 'ix_dm_entities_slug' });
  });

  it('ignores a name that appears only in the duplicate key value', () => {
    const err = sqlError(
      2627,
      "Violation of PRIMARY KEY constraint 'pk_dm_entities'. The duplicate key value is (ix_dm_entities_slug).",
    );
    expect(readUniqueViolation(err)?.key).toBe('pk_dm_entities');
  });

  it('leaves the key undefined for a localised message', () => {
    expect(readUniqueViolation(sqlError(2601, 'Doppelte Schlüsselzeile …'))).toEqual({ number: 2601, key: undefined });
  });

  it('returns undefined for other errors', () => {
    expect(readUniqueViolation(sqlError(547, 'The INSERT statement conflicted with the FOREIGN KEY constraint'))).toBeUndefined();
    expect(readUniqueViolation(new Error('Connection lost'))).toBeUndefined();
    expect(readUniqueViolation(null)).toBeUndefined();
  });
});

describe('mapUniqueViolation', () => {
  it('maps the slug index to SlugConflictError with the native error as cause', () => {
    const mapped = mapUniqueViolation(SLUG_INDEX_VIOLATION, ENTITY);
    expect(mapped).toBeInstanceOf(SlugConflictError);
    expect(mapped).toMatchObject({ slug: 'person:alex', entityType: 'person', label: 'Alex' });
    expect(mapped?.cause).toBe(SLUG_INDEX_VIOLATION);
  });

  it('maps an UPDATE that moves onto a held slug to SlugConflictError', () => {
    // SQL Server reports a unique-index clash from an UPDATE with the same
    // 2601 "Cannot insert duplicate key row" text as from an INSERT.
    const updateClash = sqlError(
      2601,
      "Cannot insert duplicate key row in object 'dbo.dm_entities' with unique index 'ix_dm_entities_slug'. The duplicate key value is (0e0f…, person:sam).",
    );
    const mapped = mapUniqueViolation(updateClash, { ...ENTITY, slug: 'person:sam', label: 'Sam' });
    expect(mapped).toBeInstanceOf(SlugConflictError);
    expect(mapped).toMatchObject({ slug: 'person:sam', cause: updateClash });
  });

  it('maps the entity primary key to DuplicateEntityError with the native error as cause', () => {
    const mapped = mapUniqueViolation(ENTITY_PK_VIOLATION, ENTITY);
    expect(mapped).toBeInstanceOf(DuplicateEntityError);
    expect(mapped?.cause).toBe(ENTITY_PK_VIOLATION);
  });

  it('maps the relationship and repository primary keys', () => {
    const rel = mapUniqueViolation(RELATIONSHIP_PK_VIOLATION, { kind: 'relationship', relationshipId: 'r1' });
    expect(rel).toBeInstanceOf(DuplicateRelationshipError);
    expect(rel?.cause).toBe(RELATIONSHIP_PK_VIOLATION);

    const repo = mapUniqueViolation(REPOSITORY_PK_VIOLATION, { kind: 'repository', repositoryId: 'repo' });
    expect(repo).toBeInstanceOf(DuplicateRepositoryError);
    expect(repo?.cause).toBe(REPOSITORY_PK_VIOLATION);
  });

  it('falls back on the error number and table when the message is localised', () => {
    expect(mapUniqueViolation(sqlError(2601, 'localised'), ENTITY)).toBeInstanceOf(SlugConflictError);
    expect(mapUniqueViolation(sqlError(2627, 'localised'), ENTITY)).toBeInstanceOf(DuplicateEntityError);
    expect(
      mapUniqueViolation(sqlError(2627, 'localised'), { kind: 'relationship', relationshipId: 'r1' }),
    ).toBeInstanceOf(DuplicateRelationshipError);
    expect(
      mapUniqueViolation(sqlError(2627, 'localised'), { kind: 'repository', repositoryId: 'repo' }),
    ).toBeInstanceOf(DuplicateRepositoryError);
    expect(
      mapUniqueViolation(sqlError(2601, 'localised'), { kind: 'relationship', relationshipId: 'r1' }),
    ).toBeUndefined();
  });

  it('returns undefined for a key the context does not own', () => {
    expect(mapUniqueViolation(SLUG_INDEX_VIOLATION, { kind: 'relationship', relationshipId: 'r1' })).toBeUndefined();
    expect(mapUniqueViolation(new Error('timeout'), ENTITY)).toBeUndefined();
  });
});

describe('UNIQUE_KEYS_BY_TABLE', () => {
  /** Every primary key, unique constraint and unique index the schema declares on a table. */
  function uniqueKeysOf(table: string): string[] {
    const ddl = getSchemaSQL('dbo');
    const keys: string[] = [];
    const tableBody = new RegExp(`CREATE TABLE \\[dbo\\]\\.\\[${table}\\] \\(([\\s\\S]*?)\\n\\);`).exec(ddl)?.[1] ?? '';
    for (const m of tableBody.matchAll(/CONSTRAINT \[(\w+)\] (?:PRIMARY KEY|UNIQUE)/g)) keys.push(m[1]!);
    for (const m of ddl.matchAll(new RegExp(`CREATE UNIQUE (?:NONCLUSTERED |CLUSTERED )?INDEX \\[(\\w+)\\]\\s+ON \\[dbo\\]\\.\\[${table}\\]`, 'g'))) {
      keys.push(m[1]!);
    }
    return keys.sort();
  }

  it('accounts for every unique key on the tables a create or update writes', () => {
    // A new unique key must be added to the mapping (or listed here as one
    // that cannot clash) so its violations are not misreported.
    const cannotClash = ['uq_dm_entities_ft_key'];
    const mapped = (table: 'entity' | 'relationship' | 'repository'): string[] =>
      Object.values(UNIQUE_KEYS_BY_TABLE[table]).filter((k): k is string => k !== undefined);

    expect(uniqueKeysOf('dm_entities')).toEqual([...mapped('entity'), ...cannotClash].sort());
    expect(uniqueKeysOf('dm_relationships')).toEqual(mapped('relationship').sort());
    expect(uniqueKeysOf('dm_repositories')).toEqual(mapped('repository').sort());
  });
});

describe('importFailure', () => {
  const row = { item: 'entity:e1', context: ENTITY };

  it('names the row and wraps a unique clash as ImportError with the typed clash as cause', () => {
    const err = importFailure(SLUG_INDEX_VIOLATION, row, undefined);
    expect(err).toBeInstanceOf(ImportError);
    expect(err.message).toMatch(/^SQL Server import rolled back: entity:e1 failed: Slug "person:alex"/);
    expect(err.cause).toBeInstanceOf(SlugConflictError);
    expect((err.cause as SlugConflictError).cause).toBe(SLUG_INDEX_VIOLATION);
  });

  it('wraps any other failure as ProviderError with the native error as cause', () => {
    const native = sqlError(547, 'FOREIGN KEY conflict');
    const err = importFailure(native, { item: 'relationship:r1', context: { kind: 'relationship', relationshipId: 'r1' } }, undefined);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain('relationship:r1 failed');
    expect(err.cause).toBe(native);
  });

  it('reports a failed rollback without hiding the original failure', () => {
    const err = importFailure(ENTITY_PK_VIOLATION, row, new Error('connection closed'));
    expect(err).toBeInstanceOf(ImportError);
    expect(err.cause).toBeInstanceOf(DuplicateEntityError);
    expect(err.message).toContain('the rollback also failed: connection closed');
  });

  it('reports a commit failure when no row was in flight', () => {
    const native = new Error('commit failed');
    const err = importFailure(native, undefined, undefined);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain('the commit failed');
  });
});
