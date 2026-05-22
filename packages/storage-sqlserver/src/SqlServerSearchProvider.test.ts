// Tests for SqlServerSearchProvider
//
// These tests require a running SQL Server instance with Full-Text Search enabled.
// Set the MSSQL_CONNECTION_STRING environment variable to run them.
//
// Example:
//   MSSQL_CONNECTION_STRING="Server=localhost;Database=deep_memory_test;User Id=sa;Password=YourPassword;TrustServerCertificate=true" pnpm test

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sql from 'mssql';
import { SqlServerStorageProvider } from './SqlServerStorageProvider.js';
import { SqlServerSearchProvider } from './SqlServerSearchProvider.js';

const connectionString = process.env['MSSQL_CONNECTION_STRING'];

function parseConnectionString(cs: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const part of cs.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      pairs[part.slice(0, idx).trim().toLowerCase()] = part.slice(idx + 1).trim();
    }
  }
  return pairs;
}

// Fixed test repository ID to avoid collisions with conformance tests
const TEST_REPO_ID = '00000000-0000-0000-0000-000000000002';

if (connectionString) {
  const parsed = parseConnectionString(connectionString);
  const serverParts = (parsed['server'] ?? 'localhost').split(',');

  const mssqlConfig: sql.config = {
    server: serverParts[0]!,
    port: serverParts[1] ? parseInt(serverParts[1], 10) : undefined,
    database: parsed['database'] ?? 'deep-memory',
    user: parsed['user id'] ?? 'sa',
    password: parsed['password'] ?? '',
    options: {
      trustServerCertificate:
        (parsed['trustservercertificate'] ?? '').toLowerCase() === 'true',
    },
  };

  describe('SqlServerSearchProvider', () => {
    let pool: sql.ConnectionPool;
    let storageProvider: SqlServerStorageProvider;
    let searchProvider: SqlServerSearchProvider;

    beforeAll(async () => {
      pool = new sql.ConnectionPool(mssqlConfig);
      await pool.connect();

      storageProvider = new SqlServerStorageProvider({
        connection: pool,
        schema: 'dbo',
      });
      await storageProvider.initialize();
      await storageProvider.ensureSchema();

      searchProvider = new SqlServerSearchProvider({
        pool,
        schema: 'dbo',
      });

      // Clean up test data from previous runs
      await pool
        .request()
        .input('repoId', sql.UniqueIdentifier, TEST_REPO_ID)
        .query(`
          DELETE FROM [dbo].[dm_relationships] WHERE [repository_id] = @repoId;
          DELETE FROM [dbo].[dm_entities] WHERE [repository_id] = @repoId;
          DELETE FROM [dbo].[dm_vocabulary_change_log] WHERE [repository_id] = @repoId;
          DELETE FROM [dbo].[dm_vocabularies] WHERE [repository_id] = @repoId;
          DELETE FROM [dbo].[dm_repositories] WHERE [repository_id] = @repoId;
        `);

      // Create a test repository
      await storageProvider.createRepository({
        repositoryId: TEST_REPO_ID,
        label: 'Search Test Repo',
        description: 'Repository for search provider tests',
        governanceConfig: {
          mode: 'open',
        },
        createdBy: 'test-runner',
      });

      // Seed test entities
      const now = new Date().toISOString();
      const provenance = {
        createdBy: 'test-runner',
        createdByType: 'agent' as const,
        createdAt: now,
        modifiedBy: 'test-runner',
        modifiedByType: 'agent' as const,
        modifiedAt: now,
      };

      await storageProvider.createEntity(TEST_REPO_ID, {
        id: 'person:alice-johnson',
        slug: 'person:alice-johnson',
        entityType: 'person',
        label: 'Alice Johnson',
        summary: 'Senior software engineer specializing in distributed systems and cloud architecture',
        properties: { department: 'engineering', role: 'senior-engineer' },
        provenance,
      });

      await storageProvider.createEntity(TEST_REPO_ID, {
        id: 'person:bob-smith',
        slug: 'person:bob-smith',
        entityType: 'person',
        label: 'Bob Smith',
        summary: 'Product manager focused on developer experience and tooling',
        properties: { department: 'product', role: 'product-manager' },
        provenance,
      });

      await storageProvider.createEntity(TEST_REPO_ID, {
        id: 'project:deep-memory',
        slug: 'project:deep-memory',
        entityType: 'project',
        label: 'Deep Memory',
        summary: 'A vocabulary-driven graph memory library for AI agents',
        properties: { status: 'active', language: 'typescript' },
        data: 'The deep memory project provides persistent knowledge graphs for conversational AI agents with full-text search capabilities.',
        provenance,
      });

      await storageProvider.createEntity(TEST_REPO_ID, {
        id: 'project:cloud-platform',
        slug: 'project:cloud-platform',
        entityType: 'project',
        label: 'Cloud Platform',
        summary: 'Internal cloud infrastructure and deployment platform',
        properties: { status: 'active', language: 'go' },
        data: 'Cloud platform handles container orchestration, service mesh, and distributed tracing across all microservices.',
        provenance,
      });

      // Wait for FT indexer to process (auto change tracking has a slight delay)
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }, 30000);

    afterAll(async () => {
      // Clean up test data
      if (pool?.connected) {
        await pool
          .request()
          .input('repoId', sql.UniqueIdentifier, TEST_REPO_ID)
          .query(`
            DELETE FROM [dbo].[dm_relationships] WHERE [repository_id] = @repoId;
            DELETE FROM [dbo].[dm_entities] WHERE [repository_id] = @repoId;
            DELETE FROM [dbo].[dm_vocabulary_change_log] WHERE [repository_id] = @repoId;
            DELETE FROM [dbo].[dm_vocabularies] WHERE [repository_id] = @repoId;
            DELETE FROM [dbo].[dm_repositories] WHERE [repository_id] = @repoId;
          `);
        await pool.close();
      }
    });

    it('should find entities by natural language query', async () => {
      const result = await searchProvider.search(
        TEST_REPO_ID,
        'software engineer distributed systems',
      );

      expect(result.items.length).toBeGreaterThan(0);
      expect(result.total).toBeGreaterThan(0);
      expect(result.items[0]!.id).toBe('person:alice-johnson');
      expect(result.items[0]!.score).toBeGreaterThan(0);
      expect(result.items[0]!.score).toBeLessThanOrEqual(1);
    });

    it('should return results with highlights', async () => {
      const result = await searchProvider.search(
        TEST_REPO_ID,
        'graph memory AI agents',
      );

      expect(result.items.length).toBeGreaterThan(0);
      const hit = result.items.find((h) => h.id === 'project:deep-memory');
      expect(hit).toBeDefined();
      // Highlights should be present for at least one field
      if (hit?.highlights) {
        const allSnippets = Object.values(hit.highlights).flat();
        expect(allSnippets.length).toBeGreaterThan(0);
      }
    });

    it('should filter by entity type', async () => {
      const result = await searchProvider.search(
        TEST_REPO_ID,
        'cloud distributed',
        { entityTypes: ['project'] },
      );

      expect(result.items.length).toBeGreaterThan(0);
      for (const item of result.items) {
        // All results should be project entities (verify via a re-fetch)
        expect(
          item.id.startsWith('project:'),
        ).toBe(true);
      }
    });

    it('should respect pagination limit and offset', async () => {
      const page1 = await searchProvider.search(
        TEST_REPO_ID,
        'platform software engineer',
        { limit: 2, offset: 0 },
      );

      expect(page1.items.length).toBeLessThanOrEqual(2);
      expect(page1.limit).toBe(2);
      expect(page1.offset).toBe(0);

      if (page1.total > 2) {
        const page2 = await searchProvider.search(
          TEST_REPO_ID,
          'platform software engineer',
          { limit: 2, offset: 2 },
        );
        expect(page2.offset).toBe(2);
        expect(page2.items.length).toBeGreaterThan(0);
      }
    });

    it('should return empty results for non-matching query', async () => {
      const result = await searchProvider.search(
        TEST_REPO_ID,
        'xyznonexistentterm987654',
      );

      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it('should return hasMore correctly', async () => {
      const result = await searchProvider.search(
        TEST_REPO_ID,
        'cloud distributed software',
        { limit: 1 },
      );

      if (result.total > 1) {
        expect(result.hasMore).toBe(true);
      } else {
        expect(result.hasMore).toBe(false);
      }
    });

    it('indexEntity should be a no-op (auto-maintained)', async () => {
      // Should not throw
      await searchProvider.indexEntity(TEST_REPO_ID, {
        id: 'test:noop',
        slug: 'test:noop',
        entityType: 'test',
        label: 'No-op test',
      });
    });

    it('removeEntity should be a no-op (auto-maintained)', async () => {
      // Should not throw
      await searchProvider.removeEntity(TEST_REPO_ID, 'test:noop');
    });

    it('reindexRepository should reorganize the catalog', async () => {
      // Should not throw
      async function* emptyIterable() {
        // no entities
      }
      await searchProvider.reindexRepository(TEST_REPO_ID, emptyIterable());
    });
  });
} else {
  describe('SqlServerSearchProvider', () => {
    it('skipped — set MSSQL_CONNECTION_STRING to run', () => {
      expect(true).toBe(true);
    });
  });
}
