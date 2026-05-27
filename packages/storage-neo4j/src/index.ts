// @utaba/deep-memory-storage-neo4j — Neo4j storage provider for deep-memory.
//
// Phase 2 surface: data model, Neo4jConnection skeleton, ensureSchema().
// CRUD and graph traversal land in later phases.

export { Neo4jStorageProvider } from './Neo4jStorageProvider.js';
export type { Neo4jStorageProviderConfig } from './Neo4jStorageProvider.js';
export { getSchemaCypher, SCHEMA_VERSION } from './schema.js';
