/**
 * Entity registry types — the canonical deduplication mechanism.
 *
 * Every entity that exists or will exist in the repository is listed in the
 * registry with a stable GUID. The registry is the single source of truth
 * for entity identity across documents and extraction runs.
 */

/** The complete entity registry */
export interface EntityRegistry {
  version: string;
  repositoryId: string;
  lastUpdated: string;
  entities: RegistryEntry[];
}

/** A single entity in the registry */
export interface RegistryEntry {
  /** Stable UUID — once assigned, never changes */
  id: string;
  /** Deterministic slug: {EntityType}:{slugified-label} */
  slug: string;
  /** Vocabulary entity type */
  entityType: string;
  /** Canonical label following vocabulary naming conventions */
  label: string;
  /** Lifecycle status */
  status: RegistryEntryStatus;
  /** Known alternative names for deduplication matching */
  aliases: string[];
  /** Which source documents reference this entity */
  sourceDocuments: string[];
}

/** Entity lifecycle status in the registry */
export type RegistryEntryStatus = 'identified' | 'extracted' | 'consolidated' | 'imported';
