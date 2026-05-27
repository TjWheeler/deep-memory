// Conformance harness skeleton for Neo4jStorageProvider — Phase 2 scope.
//
// Currently asserts only the EnsureSchemaResult shape against a live Neo4j.
// Full StorageProvider conformance (via runStorageProviderConformanceTests
// from @utaba/deep-memory/testing) lands in Phase 13 once CRUD is in place.
//
// Set NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD to run.
// Example:
//   NEO4J_URI=bolt://localhost:7687 NEO4J_USER=neo4j NEO4J_PASSWORD=local-dev-password pnpm test

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Neo4jStorageProvider } from './Neo4jStorageProvider.js';
import { SCHEMA_VERSION } from './schema.js';

const NEO4J_URI = process.env['NEO4J_URI'];
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? '';
const NEO4J_DATABASE = process.env['NEO4J_DATABASE'] ?? 'neo4j';

if (NEO4J_URI) {
  describe('Neo4jStorageProvider — ensureSchema (live)', () => {
    let provider: Neo4jStorageProvider;

    beforeAll(async () => {
      provider = new Neo4jStorageProvider({
        uri: NEO4J_URI,
        username: NEO4J_USER,
        password: NEO4J_PASSWORD,
        database: NEO4J_DATABASE,
      });
      await provider.initialize();
    });

    afterAll(async () => {
      await provider.dispose();
    });

    it('returns the expected EnsureSchemaResult shape on first call', async () => {
      const result = await provider.ensureSchema();
      expect(result).toEqual({
        databaseCreated: false,
        schemaCreated: expect.any(Boolean),
        alreadyUpToDate: expect.any(Boolean),
        schemaVersion: SCHEMA_VERSION,
      });
      // Exactly one of schemaCreated / alreadyUpToDate is true.
      expect(result.schemaCreated !== result.alreadyUpToDate).toBe(true);
    });

    it('is idempotent — second call reports alreadyUpToDate', async () => {
      const result = await provider.ensureSchema();
      expect(result).toEqual({
        databaseCreated: false,
        schemaCreated: false,
        alreadyUpToDate: true,
        schemaVersion: SCHEMA_VERSION,
      });
    });
  });
} else {
  describe('Neo4jStorageProvider', () => {
    it('skipped — set NEO4J_URI to run conformance tests', () => {
      expect(true).toBe(true);
    });
  });
}
