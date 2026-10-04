// Conformance tests for SqlServerStorageProvider
//
// These tests require a running SQL Server instance.
// Set the MSSQL_CONNECTION_STRING environment variable to run them.
//
// Example:
//   MSSQL_CONNECTION_STRING="Server=localhost;Database=deep_memory_test;User Id=sa;Password=YourPassword;TrustServerCertificate=true" pnpm test

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import mssql, { type ConnectionPool } from 'mssql';
import { runStorageProviderConformanceTests } from '@utaba/deep-memory/testing';
import type {
  Provenance,
  StoredEntity,
  StoredRelationship,
  VocabularyChangeRecord,
} from '@utaba/deep-memory/types';
import { SqlServerStorageProvider } from './SqlServerStorageProvider.js';

const connectionString = process.env['MSSQL_CONNECTION_STRING'];

// The repository id the shared conformance suite creates before every test.
// The suite has no teardown, so each factory call must remove it first.
const CONFORMANCE_REPO_ID = '40000000-0000-4000-a000-000000000001';

// The repository the SQL Server specific tests below create and remove.
const LIVE_REPO_ID = '40000000-0000-4000-a000-000000000002';

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

/** Remove a repository and everything under it, whether or not it exists. */
async function purgeRepository(provider: SqlServerStorageProvider, repositoryId: string): Promise<void> {
  const pool = (provider as unknown as { pool: ConnectionPool }).pool;
  await pool.request().input('repoId', mssql.UniqueIdentifier, repositoryId).query(`
    DELETE FROM [dbo].[dm_relationships] WHERE [repository_id] = @repoId;
    DELETE FROM [dbo].[dm_entities] WHERE [repository_id] = @repoId;
    DELETE FROM [dbo].[dm_vocabulary_change_log] WHERE [repository_id] = @repoId;
    DELETE FROM [dbo].[dm_vocabularies] WHERE [repository_id] = @repoId;
    DELETE FROM [dbo].[dm_repositories] WHERE [repository_id] = @repoId;
  `);
}

if (connectionString) {
  const parsed = parseConnectionString(connectionString);
  const serverParts = (parsed['server'] ?? 'localhost').split(',');

  async function createProvider(): Promise<SqlServerStorageProvider> {
    const provider = new SqlServerStorageProvider({
      connection: {
        server: serverParts[0]!,
        port: serverParts[1] ? parseInt(serverParts[1], 10) : undefined,
        database: parsed['database'] ?? 'deep-memory',
        user: parsed['user id'] ?? 'sa',
        password: parsed['password'] ?? '',
        options: {
          trustServerCertificate: (parsed['trustservercertificate'] ?? '').toLowerCase() === 'true',
        },
      },
      schema: 'dbo',
    });
    await provider.initialize();
    await provider.ensureSchema();
    return provider;
  }

  runStorageProviderConformanceTests(async () => {
    const provider = await createProvider();
    // Clean up only the conformance test repo from previous runs
    await purgeRepository(provider, CONFORMANCE_REPO_ID);
    return provider;
  });

  describe('SqlServerStorageProvider (live)', () => {
    let provider: SqlServerStorageProvider;

    function provenance(): Provenance {
      const now = new Date().toISOString();
      return {
        createdBy: 'live-test',
        createdByType: 'agent',
        createdAt: now,
        modifiedBy: 'live-test',
        modifiedByType: 'agent',
        modifiedAt: now,
      };
    }

    function entity(id: string, entityType: string): StoredEntity {
      return { id, slug: `slug-${id}`, entityType, label: id, properties: {}, provenance: provenance() };
    }

    function relationship(id: string, relationshipType: string, sourceEntityId: string, targetEntityId: string): StoredRelationship {
      return { id, relationshipType, sourceEntityId, targetEntityId, properties: {}, bidirectional: false, provenance: provenance() };
    }

    function changeRecord(changeId: string, previousVersion: string, newVersion: string): VocabularyChangeRecord {
      return {
        changeId,
        changeType: 'entity_type_added',
        typeName: changeId,
        previousVersion,
        newVersion,
        proposedBy: 'live-test',
        proposedAt: new Date().toISOString(),
        reason: 'live test',
      };
    }

    beforeEach(async () => {
      provider = await createProvider();
      await purgeRepository(provider, LIVE_REPO_ID);
      await provider.createRepository({
        repositoryId: LIVE_REPO_ID,
        label: 'SQL Server live tests',
        governanceConfig: { mode: 'open' },
        createdAt: new Date().toISOString(),
        createdBy: 'live-test',
      });
    });

    afterEach(async () => {
      await purgeRepository(provider, LIVE_REPO_ID);
      await provider.dispose();
    });

    it('deleteEntitiesByType matches the type name exactly, case and trailing spaces included', async () => {
      await provider.createEntity(LIVE_REPO_ID, entity('apollo', 'project'));
      await provider.createEntity(LIVE_REPO_ID, entity('gemini', 'project'));
      await provider.createEntity(LIVE_REPO_ID, entity('ada', 'person'));
      await provider.createRelationship(LIVE_REPO_ID, relationship('r1', 'WORKS_ON', 'ada', 'apollo'));

      for (const near of ['Project', 'PROJECT', 'project ']) {
        expect(await provider.deleteEntitiesByType(LIVE_REPO_ID, near)).toEqual({
          deletedEntities: 0,
          deletedRelationships: 0,
        });
      }
      expect(await provider.getEntity(LIVE_REPO_ID, 'apollo')).not.toBeNull();
      expect(await provider.getEntity(LIVE_REPO_ID, 'gemini')).not.toBeNull();
      expect(await provider.getRelationship(LIVE_REPO_ID, 'r1')).not.toBeNull();

      expect(await provider.deleteEntitiesByType(LIVE_REPO_ID, 'project')).toEqual({
        deletedEntities: 2,
        deletedRelationships: 1,
      });
      expect(await provider.getEntity(LIVE_REPO_ID, 'apollo')).toBeNull();
      expect(await provider.getEntity(LIVE_REPO_ID, 'ada')).not.toBeNull();
    });

    it('deleteRelationshipsByType matches the type name exactly, case and trailing spaces included', async () => {
      await provider.createEntity(LIVE_REPO_ID, entity('ada', 'person'));
      await provider.createEntity(LIVE_REPO_ID, entity('apollo', 'project'));
      await provider.createRelationship(LIVE_REPO_ID, relationship('r1', 'WORKS_ON', 'ada', 'apollo'));

      for (const near of ['works_on', 'Works_On', 'WORKS_ON ']) {
        expect(await provider.deleteRelationshipsByType(LIVE_REPO_ID, near)).toEqual({ deletedRelationships: 0 });
      }
      expect(await provider.getRelationship(LIVE_REPO_ID, 'r1')).not.toBeNull();

      expect(await provider.deleteRelationshipsByType(LIVE_REPO_ID, 'WORKS_ON')).toEqual({ deletedRelationships: 1 });
      expect(await provider.getRelationship(LIVE_REPO_ID, 'r1')).toBeNull();
    });

    it('a saveVocabulary whose change record fails to insert leaves the vocabulary and the log unchanged', async () => {
      const v0 = await provider.getVocabulary(LIVE_REPO_ID);
      const first = changeRecord('change-dup', v0.version, '1.0.0');
      await provider.saveVocabulary(LIVE_REPO_ID, { ...v0, version: '1.0.0' }, v0.version, first);
      const logBefore = await provider.getVocabularyChangeLog(LIVE_REPO_ID);
      expect(logBefore.total).toBe(1);

      // The same change id again violates the change log's primary key, after
      // the vocabulary UPDATE in the same transaction has already matched.
      const duplicate = changeRecord('change-dup', '1.0.0', '1.1.0');
      await expect(
        provider.saveVocabulary(LIVE_REPO_ID, { ...v0, version: '1.1.0' }, '1.0.0', duplicate),
      ).rejects.toMatchObject({ name: 'ProviderError' });

      const fresh = await createProvider();
      try {
        expect((await fresh.getVocabulary(LIVE_REPO_ID, { fresh: true })).version).toBe('1.0.0');
        expect(await fresh.getVocabularyChangeLog(LIVE_REPO_ID)).toEqual(logBefore);
      } finally {
        await fresh.dispose();
      }

      // The write that failed was rolled back whole, so the same base version still applies.
      await provider.saveVocabulary(LIVE_REPO_ID, { ...v0, version: '1.1.0' }, '1.0.0', changeRecord('change-next', '1.0.0', '1.1.0'));
      expect((await provider.getVocabularyChangeLog(LIVE_REPO_ID)).total).toBe(2);
    });
  });
} else {
  describe('SqlServerStorageProvider', () => {
    it('skipped — set MSSQL_CONNECTION_STRING to run', () => {
      expect(true).toBe(true);
    });
  });
}
