// Event types — lifecycle events emitted by the core engine

import type { CreateEntityInput, Entity, UpdateEntityInput } from './entities.js';
import type { CreateRelationshipInput, Relationship } from './relationships.js';
import type { ProvenanceContext } from './provenance.js';
import type { VocabularyChangeRecord } from './vocabulary.js';

/** All event types emitted by the Deep Memory engine */
export type DeepMemoryEventType =
  // Repository lifecycle
  | 'repository:created'
  | 'repository:opened'
  | 'repository:updated'
  | 'repository:deleted'
  // Entity lifecycle
  | 'entity:creating'
  | 'entity:created'
  | 'entity:updating'
  | 'entity:updated'
  | 'entity:deleting'
  | 'entity:deleted'
  // Relationship lifecycle
  | 'relationship:creating'
  | 'relationship:created'
  | 'relationship:removing'
  | 'relationship:removed'
  // Vocabulary lifecycle
  | 'vocabulary:proposal'
  | 'vocabulary:approved'
  | 'vocabulary:rejected'
  | 'vocabulary:pending'
  | 'vocabulary:changed'
  // Validation
  | 'validation:failed'
  // Search
  | 'search:executed'
  // Re-embedding
  | 'reembed:started'
  | 'reembed:progress'
  | 'reembed:item-failed'
  | 'reembed:completed'
  | 'reembed:failed'
  // Portability
  | 'export:started'
  | 'export:progress'
  | 'export:completed'
  | 'import:started'
  | 'import:progress'
  | 'import:item-failed'
  | 'import:completed'
  | 'import:failed'
  // Delete
  | 'delete:started'
  | 'delete:progress'
  | 'delete:completed';

/** Type-safe event payload mapping */
export type EventPayload<T extends DeepMemoryEventType> =
  T extends 'repository:created' ? { repositoryId: string; label: string } :
  T extends 'repository:opened' ? { repositoryId: string } :
  T extends 'repository:updated' ? { repositoryId: string } :
  T extends 'repository:deleted' ? { repositoryId: string } :
  T extends 'entity:creating' ? { input: CreateEntityInput } :
  T extends 'entity:created' ? { entity: Entity } :
  T extends 'entity:updating' ? { id: string; updates: UpdateEntityInput } :
  T extends 'entity:updated' ? { entity: Entity } :
  T extends 'entity:deleting' ? { ids: string[] } :
  T extends 'entity:deleted' ? { ids: string[] } :
  T extends 'relationship:creating' ? { input: CreateRelationshipInput } :
  T extends 'relationship:created' ? { relationship: Relationship } :
  T extends 'relationship:removing' ? { ids: string[] } :
  T extends 'relationship:removed' ? { ids: string[] } :
  T extends 'vocabulary:proposal' ? { proposal: VocabularyChangeRecord } :
  T extends 'vocabulary:approved' ? { change: VocabularyChangeRecord } :
  T extends 'vocabulary:rejected' ? { reason: string; duplicates?: Array<{ type: string; similarity: number }> } :
  T extends 'vocabulary:pending' ? { proposalId: string } :
  T extends 'vocabulary:changed' ? { previousVersion: string; newVersion: string; change: VocabularyChangeRecord } :
  T extends 'validation:failed' ? { operation: string; error: string; suggestions?: string[] } :
  T extends 'search:executed' ? { query: string; resultCount: number } :
  T extends 'reembed:started' ? { repositoryId: string; totalEntities: number } :
  T extends 'reembed:progress' ? { repositoryId: string; processed: number; totalEntities: number; failed: number } :
  T extends 'reembed:item-failed' ? { repositoryId: string; entityId: string; error: string } :
  T extends 'reembed:completed' ? { repositoryId: string; processed: number; failed: number; modelId: string } :
  T extends 'reembed:failed' ? { repositoryId: string; error: string } :
  T extends 'export:started' ? { repositoryId: string; totalEntities: number; totalRelationships: number } :
  T extends 'export:progress' ? { repositoryId: string; entitiesExported: number; relationshipsExported: number; totalEntities: number; totalRelationships: number; chunksCompleted: number; totalChunks: number } :
  T extends 'export:completed' ? { repositoryId: string; entityCount: number; relationshipCount: number } :
  T extends 'import:started' ? { repositoryId: string } :
  T extends 'import:progress' ? { repositoryId: string; entitiesImported: number; relationshipsImported: number; totalEntities: number; totalRelationships: number; chunksCompleted: number; totalChunks: number } :
  T extends 'import:item-failed' ? { repositoryId: string; itemId: string; itemType: 'entity' | 'relationship'; error: string } :
  T extends 'import:completed' ? { repositoryId: string; entitiesImported: number; relationshipsImported: number } :
  T extends 'import:failed' ? { repositoryId: string; error: string } :
  T extends 'delete:started' ? { repositoryId: string; totalEntities: number; totalRelationships: number } :
  T extends 'delete:progress' ? { repositoryId: string; entitiesDeleted: number; relationshipsDeleted: number; totalEntities: number; totalRelationships: number } :
  T extends 'delete:completed' ? { repositoryId: string; entitiesDeleted: number; relationshipsDeleted: number } :
  Record<string, unknown>;

/** A typed event emitted by the engine */
export interface DeepMemoryEvent<T extends DeepMemoryEventType> {
  type: T;
  timestamp: string;
  repositoryId?: string;
  provenance: ProvenanceContext;
  payload: EventPayload<T>;
}

/** Event handler function */
export type EventHandler<T extends DeepMemoryEventType> = (
  event: DeepMemoryEvent<T>,
) => void | Promise<void>;

/** Unsubscribe function returned by on() */
export type Unsubscribe = () => void;

/**
 * Result from a pre-mutation hook handler.
 * Return `{ cancel: true, reason }` to abort the operation.
 */
export interface HookResult {
  cancel?: boolean;
  reason?: string;
}
