// @utaba/deep-memory — Public API
// Vocabulary-driven graph memory for AI agents

export * from './types/index.js';
export * from './providers/index.js';

// Errors
export {
  DeepMemoryError,
  InvalidInputError,
  EntityNotFoundError,
  DuplicateEntityError,
  SlugConflictError,
  RelationshipNotFoundError,
  DuplicateRelationshipError,
  RepositoryNotFoundError,
  DuplicateRepositoryError,
  VocabularyValidationError,
  VocabularyVersionConflictError,
  RelationshipConstraintError,
  SelfReferentialRelationshipError,
  GovernanceDeniedError,
  OperationCancelledError,
  OperationAbortedError,
  EmbeddingProviderRequiredError,
  ImportError,
  ImportThrottleAbortError,
  ExportError,
  ProviderError,
  GraphTraversalProviderRequiredError,
  TraversalValidationError,
  TraversalVocabularyError,
  TraversalTimeoutError,
  QueryTimeoutError,
  UnsupportedQueryError,
  BatchPartialFailureError,
} from './core/errors.js';
export type { DeepMemoryErrorCode, BatchMember } from './core/errors.js';

// Core classes
export { DeepMemory, generateId, isValidUuid } from './core/DeepMemory.js';
export type { DeepMemoryConfig, OpenRepositoryOptions } from './core/DeepMemory.js';
export { MemoryRepository } from './core/MemoryRepository.js';
export { RepositoryValidator } from './validation/RepositoryValidator.js';

// Utilities
export { matchesPropertyFilters } from './relationships/PropertyFilterMatcher.js';
export { SAFE_IDENTIFIER_PATTERN, isSafeIdentifier } from './validation/identifier.js';
export {
  RESERVED_ENTITY_PROPERTY_KEYS,
  RESERVED_RELATIONSHIP_PROPERTY_KEYS,
  isReservedPropertyName,
  propertyNameRefusal,
  assertWritablePropertyKeys,
} from './validation/propertyNames.js';
export type { PropertyOwner } from './validation/propertyNames.js';
export { projectEntity } from './entities/entityProjection.js';
export { createSafeSink } from './usage/safeSink.js';

// Vocabulary validation — pure functions that validate entity/relationship
// inputs against a MemoryVocabulary. Exposed so out-of-repository callers
// (e.g. the indexer's pre-import conformance gate) enforce the same contract
// the core repository does, instead of re-implementing type/endpoint/enum checks.
export {
  validateEntity,
  validateRelationship,
  validatePropertyValue,
  getEntityTypeDef,
  getRelationshipTypeDef,
} from './vocabulary/VocabularyValidator.js';
export type { ValidationResult, ValidationError } from './vocabulary/VocabularyValidator.js';

// Storage providers seed this in createRepository when no initial vocabulary is
// supplied, so every provider stores the same well-formed empty vocabulary.
export { createEmptyVocabulary } from './vocabulary/VocabularySchema.js';

// Compilers (for provider authors who want to reuse them)
export {
  GremlinCompiler,
  GREMLIN_VERTEX_PROJECTION_FIELDS,
  GREMLIN_EDGE_PROJECTION_FIELDS,
  buildVertexProjectChain,
  buildEdgeProjectChain,
} from './relationships/compilers/GremlinCompiler.js';
export { CypherCompiler } from './relationships/compilers/CypherCompiler.js';
export type { TraversalCompiler, CompiledQuery } from './relationships/compilers/TraversalCompiler.js';

// Built-in providers
export { InMemoryStorageProvider } from './providers-builtin/InMemoryStorageProvider.js';
export { InMemorySearchProvider } from './providers-builtin/InMemorySearchProvider.js';
export { NoOpEmbeddingProvider } from './providers-builtin/NoOpEmbeddingProvider.js';
