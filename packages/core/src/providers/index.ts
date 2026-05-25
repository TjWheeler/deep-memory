// Provider interface re-exports — @utaba/deep-memory/providers

export type { StorageProvider, EnsureSchemaResult, EntityReadOptions } from './StorageProvider.js';
export type { EmbeddingProvider, EmbeddingProviderFactory } from './EmbeddingProvider.js';
export type {
  SearchProvider,
  SearchableEntity,
} from './SearchProvider.js';
export type {
  LockProvider,
  LockOptions,
  LockHandle,
} from './LockProvider.js';
export type {
  GraphTraversalProvider,
  GraphTraversalCapabilities,
} from './GraphTraversalProvider.js';
