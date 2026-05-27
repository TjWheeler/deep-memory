// Snapshot tests for the constraint / index DDL emitted by getSchemaCypher().
// The statements are Cypher 25-audited (see D7 in plans/neo4j-provider.md) —
// these tests lock them as a regression detector so future plan-driven schema
// changes are deliberate.

import { describe, it, expect } from 'vitest';
import { getSchemaCypher, SCHEMA_VERSION } from './schema.js';

describe('schema', () => {
  it('exposes a stable SCHEMA_VERSION', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('returns six DDL statements — three constraints, two range indexes, one fulltext', () => {
    const statements = getSchemaCypher();
    expect(statements).toHaveLength(6);
    const kinds = statements.map((s) => s.split('\n')[0]!.trim());
    expect(kinds).toEqual([
      'CREATE CONSTRAINT dm_entity_unique IF NOT EXISTS',
      'CREATE CONSTRAINT dm_entity_slug_unique IF NOT EXISTS',
      'CREATE CONSTRAINT dm_repository_unique IF NOT EXISTS',
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

  it('every composite constraint / index leads with repositoryId — D3b layer 1', () => {
    // D3b: the planner picks repositoryId as the cheap discriminator only if
    // it appears first in the composite. dm_repository_unique is single-column
    // (the repositoryId itself), so it's exempt.
    const composite = getSchemaCypher().filter(
      (s) => !s.includes('dm_repository_unique') && !s.includes('FULLTEXT'),
    );
    for (const statement of composite) {
      expect(statement).toMatch(/\(n\.repositoryId,/);
    }
  });

  it('matches the snapshot — locks the verbatim Cypher 25 text', () => {
    expect(getSchemaCypher()).toMatchSnapshot();
  });
});
