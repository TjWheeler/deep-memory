// Repository types — isolated knowledge domains

import type {
  GovernanceConfig,
  GovernanceMode,
  VocabularyInput,
} from './vocabulary.js';

/** Extensible metadata bag persisted as a single JSON column */
export interface RepositoryMetadata {
  /** Embedding model identifier (e.g. "Qwen/Qwen3-Embedding-8B") */
  embeddingModelId?: string;
  /** Dimensionality of embedding vectors */
  embeddingDimensions?: number;
  /** Arbitrary additional properties */
  [key: string]: unknown;
}

/** Configuration for creating a new repository */
export interface RepositoryConfig {
  /** Optional: if omitted a GUID is generated automatically */
  repositoryId?: string;
  type?: string;
  label: string;
  description?: string;
  /** Legal terms, licence, or compliance notes (stored but excluded from list queries) */
  legal?: string;
  /** Repository owner identifier (stored but excluded from list queries) */
  owner?: string;
  /** Initial vocabulary definition */
  vocabulary?: VocabularyInput;
  /** Governance configuration */
  governance?: GovernanceConfig;
  /** Extensible metadata — embedding model info, custom fields, etc. */
  metadata?: RepositoryMetadata;
}

/** Summary of a repository for listing */
export interface RepositorySummary {
  repositoryId: string;
  type?: string;
  label: string;
  description?: string;
  governanceMode: GovernanceMode;
  stats?: RepositoryStats;
}

/** Repository statistics */
export interface RepositoryStats {
  entityCount: number;
  relationshipCount: number;
  vocabularyVersion: string;
  entityTypeBreakdown: Record<string, number>;
  relationshipTypeBreakdown: Record<string, number>;
}

/** Internal stored representation of a repository */
export interface StoredRepository {
  repositoryId: string;
  type?: string;
  label: string;
  description?: string;
  /** Legal terms, licence, or compliance notes */
  legal?: string;
  /** Repository owner identifier */
  owner?: string;
  governanceConfig: GovernanceConfig;
  /** Extensible metadata bag (embedding model info, custom fields, etc.) */
  metadata?: RepositoryMetadata;
  createdAt: string;
  createdBy: string;
}

/** Internal stored summary for listing */
export interface StoredRepositorySummary {
  repositoryId: string;
  type?: string;
  label: string;
  description?: string;
  governanceConfig: GovernanceConfig;
}

/** Fields that can be updated on an existing repository */
export interface RepositoryUpdate {
  label?: string;
  description?: string;
  type?: string;
  legal?: string;
  owner?: string;
  governanceConfig?: GovernanceConfig;
  /** Metadata updates — merged with existing metadata (shallow merge) */
  metadata?: RepositoryMetadata;
}

/** Filter for listing repositories */
export interface RepositoryFilter {
  /** Filter by repository type */
  type?: string;
  /** Include statistics */
  includeStats?: boolean;
  /** Maximum number of results (default 20) */
  limit?: number;
  /** Pagination offset */
  offset?: number;
}

/** Configuration passed to the storage provider for repository creation */
export interface StorageRepositoryConfig {
  repositoryId: string;
  type?: string;
  label: string;
  description?: string;
  /** Legal terms, licence, or compliance notes */
  legal?: string;
  /** Repository owner identifier */
  owner?: string;
  governanceConfig: GovernanceConfig;
  /** Extensible metadata bag */
  metadata?: RepositoryMetadata;
  createdAt: string;
  createdBy: string;
}
