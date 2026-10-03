// Full-text search ordering under the `searchScoring` option (live).
//
// The `dm_entity_text` index covers every repository in the database, and a
// Lucene score is computed from term statistics over the whole index. With
// `'isolated'` scoring the search-term branch of `findEntities` orders a
// repository's hits by `label`, then `id`, so the order cannot move when
// another repository's data changes. The default, `'relevance'`, keeps the
// score order.
//
// Set NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD to run. Skipped otherwise so
// CI builds without a live Neo4j stay green.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidInputError, RepositoryNotFoundError } from '@utaba/deep-memory';
import type { StoredEntity } from '@utaba/deep-memory/types';
import { Neo4jStorageProvider } from './Neo4jStorageProvider.js';
import type { Neo4jSearchScoring } from './queries/entity.js';

const NEO4J_URI = process.env['NEO4J_URI'];
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? '';
const NEO4J_DATABASE = process.env['NEO4J_DATABASE'] ?? 'neo4j';

function makeEntity(id: string, label: string): StoredEntity {
  const now = new Date().toISOString();
  return {
    id,
    slug: `note:${id}`,
    entityType: 'Note',
    label,
    summary: '',
    properties: {},
    provenance: {
      createdBy: 'search-scoring-test',
      createdByType: 'agent',
      createdAt: now,
      modifiedBy: 'search-scoring-test',
      modifiedByType: 'agent',
      modifiedAt: now,
    },
  };
}

describe('Neo4jStorageProvider — searchScoring config', () => {
  const connection = { uri: 'bolt://localhost:7687', username: 'neo4j', password: 'unused' };

  it('accepts each documented mode and the default', async () => {
    for (const searchScoring of [undefined, 'relevance', 'isolated'] as const) {
      const provider = new Neo4jStorageProvider({ ...connection, searchScoring });
      await provider.dispose();
    }
  });

  it('refuses any other value at construction', () => {
    // An untyped host config can carry any string.
    const untyped: string = 'score';
    expect(() => new Neo4jStorageProvider({ ...connection, searchScoring: untyped as Neo4jSearchScoring })).toThrow(
      InvalidInputError,
    );
  });
});

if (NEO4J_URI) {
  describe('Neo4jStorageProvider — searchScoring (live)', () => {
    const config = { uri: NEO4J_URI, username: NEO4J_USER, password: NEO4J_PASSWORD, database: NEO4J_DATABASE };
    // A term unlikely to appear in any other test's data, so the hits are
    // this suite's own.
    const term = `qzscore${randomUUID().slice(0, 8)}`;
    let relevance: Neo4jStorageProvider;
    let isolated: Neo4jStorageProvider;
    const repositories: string[] = [];
    let repositoryA: string;
    let repositoryB: string;

    async function newRepository(): Promise<string> {
      const repositoryId = randomUUID();
      repositories.push(repositoryId);
      await relevance.createRepository({
        repositoryId,
        label: 'search scoring',
        governanceConfig: { mode: 'open' },
        createdAt: new Date().toISOString(),
        createdBy: 'search-scoring-test',
      });
      return repositoryId;
    }

    beforeAll(async () => {
      relevance = new Neo4jStorageProvider(config);
      await relevance.initialize();
      await relevance.ensureSchema();
      isolated = new Neo4jStorageProvider({ ...config, searchScoring: 'isolated' });
      await isolated.initialize();

      repositoryA = await newRepository();
      repositoryB = await newRepository();
      // Two hits share a label so the id tie-break is visible; the strongest
      // match by score sorts last by label.
      await relevance.createEntity(repositoryA, makeEntity('a-zulu', `Zulu ${term} ${term} ${term}`));
      await relevance.createEntity(repositoryA, makeEntity('a-bravo-2', `Bravo ${term}`));
      await relevance.createEntity(repositoryA, makeEntity('a-bravo-1', `Bravo ${term}`));
      await relevance.createEntity(repositoryA, makeEntity('a-mike', 'Mike unrelated'));
    }, 60_000);

    afterAll(async () => {
      for (const repositoryId of repositories) {
        try {
          await relevance.deleteRepository(repositoryId);
        } catch (err) {
          if (!(err instanceof RepositoryNotFoundError)) throw err;
        }
      }
      await isolated.dispose();
      await relevance.dispose();
    }, 60_000);

    async function searchIds(provider: Neo4jStorageProvider, limit = 10, offset = 0): Promise<string[]> {
      const page = await provider.findEntities(repositoryA, { searchTerm: term, limit, offset });
      return page.items.map((entity) => entity.id);
    }

    it("'isolated' orders the repository's hits by label, then id", async () => {
      expect(await searchIds(isolated)).toEqual(['a-bravo-1', 'a-bravo-2', 'a-zulu']);
      const page = await isolated.findEntities(repositoryA, { searchTerm: term, limit: 2, offset: 1 });
      expect(page.items.map((entity) => entity.id)).toEqual(['a-bravo-2', 'a-zulu']);
      expect(page.total).toBe(3);
    });

    it("'isolated' order does not move when another repository's data changes", async () => {
      const before = await searchIds(isolated);
      for (let i = 0; i < 20; i++) {
        await relevance.createEntity(repositoryB, makeEntity(`b-${i}`, `Bravo ${term}`));
      }
      expect(await searchIds(isolated)).toEqual(before);
    });

    it("'relevance' (the default) returns the same hits in score order", async () => {
      const ids = await searchIds(relevance);
      expect([...ids].sort()).toEqual(['a-bravo-1', 'a-bravo-2', 'a-zulu']);
      expect(ids[0]).toBe('a-zulu');
    });
  });
} else {
  describe('Neo4jStorageProvider — searchScoring', () => {
    it('skipped — set NEO4J_URI to run', () => {
      expect(true).toBe(true);
    });
  });
}
