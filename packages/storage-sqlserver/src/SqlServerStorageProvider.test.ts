// Conformance tests for SqlServerStorageProvider
//
// These tests require a running SQL Server instance.
// Set the MSSQL_CONNECTION_STRING environment variable to run them.
//
// Example:
//   MSSQL_CONNECTION_STRING="Server=localhost;Database=deep_memory_test;User Id=sa;Password=YourPassword;TrustServerCertificate=true" pnpm test

import { describe, it, expect } from 'vitest';
import mssql, { type ConnectionPool } from 'mssql';
import { runStorageProviderConformanceTests } from '@utaba/deep-memory/testing';
import { SqlServerStorageProvider } from './SqlServerStorageProvider.js';

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

if (connectionString) {
  const parsed = parseConnectionString(connectionString);
  const serverParts = (parsed['server'] ?? 'localhost').split(',');

  runStorageProviderConformanceTests(async () => {
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

    // Clean up only the conformance test repo from previous runs
    const pool = (provider as unknown as { pool: ConnectionPool }).pool;
    await pool.request().input('repoId', mssql.UniqueIdentifier, '00000000-0000-0000-0000-000000000001').query(`
      DELETE FROM [dbo].[dm_relationships] WHERE [repository_id] = @repoId;
      DELETE FROM [dbo].[dm_entities] WHERE [repository_id] = @repoId;
      DELETE FROM [dbo].[dm_vocabulary_change_log] WHERE [repository_id] = @repoId;
      DELETE FROM [dbo].[dm_vocabularies] WHERE [repository_id] = @repoId;
      DELETE FROM [dbo].[dm_repositories] WHERE [repository_id] = @repoId;
    `);

    return provider;
  });
} else {
  describe('SqlServerStorageProvider', () => {
    it('skipped — set MSSQL_CONNECTION_STRING to run', () => {
      expect(true).toBe(true);
    });
  });
}
