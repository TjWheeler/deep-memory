// Snapshot tests for the constraint / index DDL emitted by getSchemaCypher().
// The statements are audited against Cypher 25; these tests lock them as a
// regression detector so that any schema change is deliberate and comes with
// a SCHEMA_VERSION bump.

import { describe, it, expect } from 'vitest';
import { getSchemaCypher, SCHEMA_VERSION } from './schema.js';

describe('schema', () => {
  it('exposes a stable SCHEMA_VERSION', () => {
    expect(SCHEMA_VERSION).toBe(2);
  });

  it('returns eight DDL statements — four constraints, three range indexes, one fulltext', () => {
    const statements = getSchemaCypher();
    expect(statements).toHaveLength(8);
    const kinds = statements.map((s) => s.split('\n')[0]!.trim());
    expect(kinds).toEqual([
      'CREATE CONSTRAINT dm_entity_unique IF NOT EXISTS',
      'CREATE CONSTRAINT dm_entity_slug_unique IF NOT EXISTS',
      'CREATE CONSTRAINT dm_repository_unique IF NOT EXISTS',
      'CREATE CONSTRAINT dm_vocabulary_change_unique IF NOT EXISTS',
      'CREATE INDEX dm_vocabulary_repository IF NOT EXISTS',
      'CREATE INDEX dm_entity_type_lookup IF NOT EXISTS',
      'CREATE INDEX dm_entity_modified IF NOT EXISTS',
      'CREATE FULLTEXT INDEX dm_entity_text IF NOT EXISTS',
    ]);
  });

  it('every statement is idempotent (IF NOT EXISTS)', () => {
    for (const statement of getSchemaCypher()) {
      expect(statement).toContain('IF NOT EXISTS');
    }
  });

  it('every composite constraint / index leads with repositoryId', () => {
    // The planner picks repositoryId as the cheap discriminator only if
    // it appears first in the composite. dm_repository_unique and
    // dm_vocabulary_repository are single-column (the repositoryId itself), so
    // they're exempt.
    const composite = getSchemaCypher().filter(
      (s) => !s.includes('dm_repository_unique') && !s.includes('dm_vocabulary_repository') && !s.includes('FULLTEXT'),
    );
    for (const statement of composite) {
      expect(statement).toMatch(/\(n\.repositoryId,/);
    }
  });

  it('matches the snapshot — locks the verbatim Cypher 25 text', () => {
    expect(getSchemaCypher()).toMatchSnapshot();
  });
});
