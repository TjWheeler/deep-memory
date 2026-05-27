// @utaba/deep-memory-storage-neo4j — Neo4j storage provider for deep-memory.
//
// Current public surface: data model, Neo4jConnection skeleton, ensureSchema(),
// and the per-operation usage sink contract. CRUD and graph traversal are
// added incrementally.

export { Neo4jStorageProvider } from './Neo4jStorageProvider.js';
export type { Neo4jStorageProviderConfig } from './Neo4jStorageProvider.js';
export { getSchemaCypher, SCHEMA_VERSION } from './schema.js';
