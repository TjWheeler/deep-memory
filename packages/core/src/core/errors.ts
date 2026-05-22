// Error hierarchy — typed errors with actionable suggestions

/** Error codes for all Deep Memory errors */
export type DeepMemoryErrorCode =
  | 'INVALID_INPUT'
  | 'ENTITY_NOT_FOUND'
  | 'ENTITY_ALREADY_EXISTS'
  | 'RELATIONSHIP_NOT_FOUND'
  | 'RELATIONSHIP_ALREADY_EXISTS'
  | 'REPOSITORY_NOT_FOUND'
  | 'REPOSITORY_ALREADY_EXISTS'
  | 'VOCABULARY_VALIDATION_FAILED'
  | 'RELATIONSHIP_CONSTRAINT_FAILED'
  | 'SELF_REFERENTIAL_RELATIONSHIP'
  | 'GOVERNANCE_DENIED'
  | 'OPERATION_CANCELLED'
  | 'OPERATION_ABORTED'
  | 'EMBEDDING_PROVIDER_REQUIRED'
  | 'IMPORT_ERROR'
  | 'EXPORT_ERROR'
  | 'PROVIDER_ERROR'
  | 'GRAPH_TRAVERSAL_PROVIDER_REQUIRED'
  | 'TRAVERSAL_VALIDATION_FAILED'
  | 'TRAVERSAL_VOCABULARY_ERROR'
  | 'TRAVERSAL_TIMEOUT';

/** Base error class for all Deep Memory errors */
export class DeepMemoryError extends Error {
  readonly code: DeepMemoryErrorCode;
  readonly suggestion?: string;

  constructor(code: DeepMemoryErrorCode, message: string, suggestion?: string) {
    super(message);
    this.name = 'DeepMemoryError';
    this.code = code;
    this.suggestion = suggestion;
  }
}

/** Input validation failed (e.g. invalid ID format) */
export class InvalidInputError extends DeepMemoryError {
  readonly field: string;

  constructor(field: string, message: string, suggestion?: string) {
    super(
      'INVALID_INPUT',
      message,
      suggestion ?? `Check the value of "${field}" and try again.`,
    );
    this.name = 'InvalidInputError';
    this.field = field;
  }
}

/** Entity was not found in the repository */
export class EntityNotFoundError extends DeepMemoryError {
  readonly id: string;
  readonly slug?: string;

  constructor(idOrSlug: string, slug?: string) {
    super(
      'ENTITY_NOT_FOUND',
      `Entity "${idOrSlug}" not found`,
      `Check the entity ID or slug is correct. Use findEntities() to search by label if unknown.`,
    );
    this.name = 'EntityNotFoundError';
    this.id = idOrSlug;
    this.slug = slug;
  }
}

/** Attempted to create an entity with an ID that already exists */
export class DuplicateEntityError extends DeepMemoryError {
  readonly id: string;

  constructor(id: string) {
    super(
      'ENTITY_ALREADY_EXISTS',
      `Entity "${id}" already exists`,
      `Use updateEntity() to modify an existing entity, or omit id to auto-generate a unique one.`,
    );
    this.name = 'DuplicateEntityError';
    this.id = id;
  }
}

/** Relationship was not found */
export class RelationshipNotFoundError extends DeepMemoryError {
  readonly relationshipId: string;

  constructor(relationshipId: string) {
    super(
      'RELATIONSHIP_NOT_FOUND',
      `Relationship "${relationshipId}" not found`,
      `Check the relationship ID is correct. Use getRelationships() to list relationships for an entity.`,
    );
    this.name = 'RelationshipNotFoundError';
    this.relationshipId = relationshipId;
  }
}

/** Attempted to create a relationship with an ID that already exists */
export class DuplicateRelationshipError extends DeepMemoryError {
  readonly relationshipId: string;

  constructor(relationshipId: string) {
    super(
      'RELATIONSHIP_ALREADY_EXISTS',
      `Relationship "${relationshipId}" already exists`,
      `Omit relationshipId to auto-generate a unique one, or use a different explicit ID.`,
    );
    this.name = 'DuplicateRelationshipError';
    this.relationshipId = relationshipId;
  }
}

/** Repository was not found */
export class RepositoryNotFoundError extends DeepMemoryError {
  readonly repositoryId: string;

  constructor(repositoryId: string) {
    super(
      'REPOSITORY_NOT_FOUND',
      `Repository "${repositoryId}" not found`,
      `Use listRepositories() to see available repositories, or createRepository() to create a new one.`,
    );
    this.name = 'RepositoryNotFoundError';
    this.repositoryId = repositoryId;
  }
}

/** Attempted to create a repository with an ID that already exists */
export class DuplicateRepositoryError extends DeepMemoryError {
  readonly repositoryId: string;

  constructor(repositoryId: string) {
    super(
      'REPOSITORY_ALREADY_EXISTS',
      `Repository "${repositoryId}" already exists`,
      `Use openRepository() to access an existing repository, or choose a different ID.`,
    );
    this.name = 'DuplicateRepositoryError';
    this.repositoryId = repositoryId;
  }
}

/** Entity or relationship failed vocabulary validation */
export class VocabularyValidationError extends DeepMemoryError {
  readonly errors: Array<{ field: string; message: string; suggestion?: string }>;

  constructor(
    errors: Array<{ field: string; message: string; suggestion?: string }>,
  ) {
    const errorMsg = errors.map((e) => e.message).join('; ');
    const suggestions = errors
      .filter((e) => e.suggestion)
      .map((e) => e.suggestion!);

    super(
      'VOCABULARY_VALIDATION_FAILED',
      `Vocabulary validation failed: ${errorMsg}`,
      suggestions.length > 0
        ? suggestions.join(' ')
        : `Check the repository vocabulary with getVocabulary() to see valid types and properties.`,
    );
    this.name = 'VocabularyValidationError';
    this.errors = errors;
  }
}

/** Relationship source/target entity types violate vocabulary constraints */
export class RelationshipConstraintError extends DeepMemoryError {
  readonly relationshipType: string;
  readonly sourceType?: string;
  readonly targetType?: string;

  constructor(
    relationshipType: string,
    message: string,
    sourceType?: string,
    targetType?: string,
  ) {
    super(
      'RELATIONSHIP_CONSTRAINT_FAILED',
      message,
      `Check the vocabulary for allowed source/target types on "${relationshipType}".`,
    );
    this.name = 'RelationshipConstraintError';
    this.relationshipType = relationshipType;
    this.sourceType = sourceType;
    this.targetType = targetType;
  }
}

/** Relationship source and target entity are the same — self-references are not permitted */
export class SelfReferentialRelationshipError extends DeepMemoryError {
  readonly entityId: string;
  readonly relationshipType: string;

  constructor(entityId: string, relationshipType: string) {
    super(
      'SELF_REFERENTIAL_RELATIONSHIP',
      `Self-referential relationship not allowed: "${relationshipType}" from entity "${entityId}" to itself`,
      `Relationships must connect two different entities. Check that sourceEntityId and targetEntityId refer to distinct entities.`,
    );
    this.name = 'SelfReferentialRelationshipError';
    this.entityId = entityId;
    this.relationshipType = relationshipType;
  }
}

/** Governance rules denied the operation */
export class GovernanceDeniedError extends DeepMemoryError {
  readonly governanceMode: string;

  constructor(governanceMode: string, reason: string) {
    super(
      'GOVERNANCE_DENIED',
      `Governance denied: ${reason}`,
      governanceMode === 'locked'
        ? `The vocabulary is locked. Change governance mode to "managed" or "open" to allow modifications.`
        : `The operation was denied by governance rules. Review the governance configuration.`,
    );
    this.name = 'GovernanceDeniedError';
    this.governanceMode = governanceMode;
  }
}

/** A pre-mutation hook cancelled the operation */
export class OperationCancelledError extends DeepMemoryError {
  readonly operation: string;
  readonly reason: string;

  constructor(operation: string, reason: string) {
    super(
      'OPERATION_CANCELLED',
      `${operation} cancelled: ${reason}`,
      `A pre-mutation hook cancelled this operation. Review registered hooks if this is unexpected.`,
    );
    this.name = 'OperationCancelledError';
    this.operation = operation;
    this.reason = reason;
  }
}

/**
 * A long-running operation was aborted by a caller-supplied AbortSignal.
 * Cooperative — the in-flight batch/chunk completes before the abort is honoured,
 * and any state written before the abort is left in place.
 */
export class OperationAbortedError extends DeepMemoryError {
  readonly operation: string;

  constructor(operation: string) {
    super(
      'OPERATION_ABORTED',
      `${operation} aborted by caller`,
      `The caller's AbortSignal was triggered. Partial state from completed batches has been retained.`,
    );
    this.name = 'OperationAbortedError';
    this.operation = operation;
  }
}

/** Semantic search was attempted without an embedding provider */
export class EmbeddingProviderRequiredError extends DeepMemoryError {
  constructor() {
    super(
      'EMBEDDING_PROVIDER_REQUIRED',
      'EmbeddingProvider required: no embedding provider is configured',
      `Provide an EmbeddingProvider in the DeepMemory config to use semantic search (searchByConcept).`,
    );
    this.name = 'EmbeddingProviderRequiredError';
  }
}

/** Error during import operations */
export class ImportError extends DeepMemoryError {
  constructor(message: string, suggestion?: string) {
    super(
      'IMPORT_ERROR',
      message,
      suggestion ?? `Verify the archive format and check that the target repository is accessible.`,
    );
    this.name = 'ImportError';
  }
}

/**
 * Import was aborted by the adaptive concurrency circuit breaker. The runner
 * was already at minimum concurrency and continued to observe throttling;
 * further attempts would not have helped. The carrier fields describe the
 * runner state at the moment of abort.
 */
export class ImportThrottleAbortError extends ImportError {
  constructor(
    public readonly concurrency: number,
    public readonly consecutiveThrottlesAtMin: number,
    public readonly tasksCompleted: number,
    public readonly throttledCount: number,
  ) {
    super(
      `Import aborted: ${consecutiveThrottlesAtMin} consecutive throttled tasks while at minimum concurrency (${concurrency}). ` +
        `Tasks completed before abort: ${tasksCompleted}; total throttled: ${throttledCount}.`,
      `Increase the storage tier's request-unit budget, or raise BulkImportOptions.adaptiveConcurrency.maxConsecutiveThrottlesAtMin if continuing despite sustained throttling is acceptable.`,
    );
    this.name = 'ImportThrottleAbortError';
  }
}

/** Error during export operations */
export class ExportError extends DeepMemoryError {
  constructor(message: string, suggestion?: string) {
    super(
      'EXPORT_ERROR',
      message,
      suggestion ?? `Verify the repository exists and the storage provider is accessible.`,
    );
    this.name = 'ExportError';
  }
}

/** Generic provider-level error */
export class ProviderError extends DeepMemoryError {
  constructor(message: string, suggestion?: string) {
    super(
      'PROVIDER_ERROR',
      message,
      suggestion ?? `Check provider configuration and connectivity.`,
    );
    this.name = 'ProviderError';
  }
}

/** Thrown when executeNativeQuery() is called but no GraphTraversalProvider is registered. */
export class GraphTraversalProviderRequiredError extends DeepMemoryError {
  constructor() {
    super(
      'GRAPH_TRAVERSAL_PROVIDER_REQUIRED',
      'GraphTraversalProvider required: no graph traversal provider is configured',
      `Provide a GraphTraversalProvider in the DeepMemory config to use native graph queries. Structured traversals via traverse() work without a provider using fallback BFS.`,
    );
    this.name = 'GraphTraversalProviderRequiredError';
  }
}

/** Thrown when a TraversalSpec is structurally invalid. */
export class TraversalValidationError extends DeepMemoryError {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(
      'TRAVERSAL_VALIDATION_FAILED',
      `Traversal validation failed: ${errors.join('; ')}`,
      `Check the TraversalSpec structure. Each spec needs a start (entityId, entityType, or filter), at least one step, and a returnMode.`,
    );
    this.name = 'TraversalValidationError';
    this.errors = errors;
  }
}

/** Thrown when a TraversalSpec references relationship/entity types not in the vocabulary. */
export class TraversalVocabularyError extends DeepMemoryError {
  readonly unknownTypes: string[];

  constructor(unknownTypes: string[]) {
    super(
      'TRAVERSAL_VOCABULARY_ERROR',
      `Traversal references unknown types: ${unknownTypes.join(', ')}`,
      `Use getVocabulary() to see valid entity and relationship types for this repository.`,
    );
    this.name = 'TraversalVocabularyError';
    this.unknownTypes = unknownTypes;
  }
}

/** Thrown when a native query times out. */
export class TraversalTimeoutError extends DeepMemoryError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      'TRAVERSAL_TIMEOUT',
      `Traversal timed out after ${timeoutMs}ms`,
      `Try reducing the traversal depth, adding more specific filters, or increasing the timeout on your GraphTraversalProvider.`,
    );
    this.name = 'TraversalTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}
