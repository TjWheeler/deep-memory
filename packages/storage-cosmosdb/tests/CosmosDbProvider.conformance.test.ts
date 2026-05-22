// Conformance test suite for CosmosDbProvider
// Requires a running CosmosDB emulator with Gremlin endpoint enabled.
// Set environment variables:
//   COSMOSDB_GREMLIN_ENDPOINT=wss://localhost:8901/
//   COSMOSDB_KEY=C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==

import { describe } from 'vitest';
import { runStorageProviderConformanceTests } from '@utaba/deep-memory/testing';
import { CosmosDbProvider } from '../src/CosmosDbProvider.js';

const skipIfNoEmulator = !process.env['COSMOSDB_GREMLIN_ENDPOINT'];

// The conformance suite's stable repo ID — must match conformance.ts
const CONFORMANCE_REPO_ID = '40000000-0000-4000-a000-000000000001';

(skipIfNoEmulator ? describe.skip : describe)('CosmosDB conformance', () => {
  runStorageProviderConformanceTests(async () => {
    const provider = new CosmosDbProvider({
      endpoint: process.env['COSMOSDB_GREMLIN_ENDPOINT']!,
      key: process.env['COSMOSDB_KEY']!,
      database: 'deep-memory-test',
      container: 'graph-test',
      rejectUnauthorized: false,
    });
    await provider.initialize();

    // Clean up any leftover data from prior test runs so each test starts fresh
    try {
      await provider.deleteRepository(CONFORMANCE_REPO_ID);
    } catch {
      // Repository may not exist — that's fine
    }

    return provider;
  });
});
