// Error hierarchy — typed errors with actionable suggestions

/** Error codes for all Deep Memory errors */
export type DeepMemoryErrorCode =
  | 'INVALID_INPUT'
  | 'ENTITY_NOT_FOUND'
  | 'ENTITY_ALREADY_EXISTS'
  | 'SLUG_CONFLICT'
  | 'RELATIONSHIP_NOT_FOUND'
  | 'RELATIONSHIP_ALREADY_EXISTS'
  | 'REPOSITORY_NOT_FOUND'
  | 'REPOSITORY_ALREADY_EXISTS'
  | 'VOCABULARY_VALIDATION_FAILED'
  | 'VOCABULARY_VERSION_CONFLICT'
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
  | 'TRAVERSAL_TIMEOUT'
  | 'QUERY_TIMEOUT'
  | 'UNSUPPORTED_QUERY';

/**
 * True when `err` is an error carrying the Deep Memory `code`.
 *
 * Matches on the code rather than `instanceof`: errors raised by a storage
 * provider may come from the provider's own copy of this package (a
 * duplicated install, or a bundled build), and an error from another copy is
 * not an instance of this copy's class.
 */
export function hasErrorCode(err: unknown, code: DeepMemoryErrorCode): boolean {
  return err instanceof Error && 'code' in err && err.code === code;
}

/** True when `err` reports a slug held by another entity (see {@link SlugConflictError}). */
export function isSlugConflict(err: unknown): boolean {
  return hasErrorCode(err, 'SLUG_CONFLICT');
}

/** Base error class for all Deep Memory errors */
export class DeepMemoryError extends Error {
  readonly code: DeepMemoryErrorCode;
  readonly suggestion?: string;

  constructor(
    code: DeepMemoryErrorCode,
    message: string,
    suggestion?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
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

  constructor(id: string, options?: ErrorOptions) {
    super(
      'ENTITY_ALREADY_EXISTS',
      `Entity "${id}" already exists`,
      `Use updateEntity() to modify an existing entity, or omit id to auto-generate a unique one.`,
      options,
    );
    this.name = 'DuplicateEntityError';
    this.id = id;
  }
}

/**
 * Attempted to create or update an entity with a slug already held by a
 * different entity in the same repository.
 *
 * Slugs are derived from the entity type and label and are unique per
 * repository. The engine picks a free slug before it writes, but that check
 * and the write are separate steps, so two concurrent writes with the same
 * type and label can pick the same candidate; the store's uniqueness rule
 * then refuses the second. The refusal is about the slug, not the entity's
 * id, which is why this is not a `DuplicateEntityError`. Entity create and
 * update retry with the next free slug before letting this error reach the
 * caller.
 */
export class SlugConflictError extends DeepMemoryError {
  readonly slug: string;
  readonly entityType?: string;
  readonly label?: string;

  constructor(
    slug: string,
    details: { entityType?: string; label?: string } = {},
    options?: ErrorOptions,
  ) {
    const subject =
      details.entityType !== undefined && details.label !== undefined
        ? ` for ${details.entityType} "${details.label}"`
        : '';
    super(
      'SLUG_CONFLICT',
      `Slug "${slug}"${subject} is already taken by another entity in this repository`,
      `Retry the write: a new attempt picks the next free slug. Repeated conflicts mean other writers are creating or renaming entities to the same type and label at the same time.`,
      options,
    );
    this.name = 'SlugConflictError';
    this.slug = slug;
    this.entityType = details.entityType;
    this.label = details.label;
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

  constructor(relationshipId: string, options?: ErrorOptions) {
    super(
      'RELATIONSHIP_ALREADY_EXISTS',
      `Relationship "${relationshipId}" already exists`,
      `Omit relationshipId to auto-generate a unique one, or use a different explicit ID.`,
      options,
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

  constructor(repositoryId: string, options?: ErrorOptions) {
    super(
      'REPOSITORY_ALREADY_EXISTS',
      `Repository "${repositoryId}" already exists`,
      `Use openRepository() to access an existing repository, or choose a different ID.`,
      options,
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

/** A vocabulary write expected a stored version that no longer matches (compare-and-set failed) */
export class VocabularyVersionConflictError extends DeepMemoryError {
  readonly repositoryId: string;
  readonly expectedVersion: string;
  readonly actualVersion: string;

  constructor(repositoryId: string, expectedVersion: string, actualVersion: string) {
    super(
      'VOCABULARY_VERSION_CONFLICT',
      `Vocabulary for repository "${repositoryId}" was changed concurrently: expected version "${expectedVersion}" but the stored version is "${actualVersion}"`,
      `Re-read the vocabulary with getVocabulary() and re-submit the proposal against the current version.`,
    );
    this.name = 'VocabularyVersionConflictError';
    this.repositoryId = repositoryId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
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
  constructor(message: string, suggestion?: string, options?: ErrorOptions) {
    super(
      'IMPORT_ERROR',
      message,
      suggestion ?? `Verify the archive format and check that the target repository is accessible.`,
      options,
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

/**
 * Generic provider-level error. A provider that builds one from a backend
 * error passes that error as `options.cause`, so hosts can inspect the
 * backend's own code without parsing `message`.
 */
export class ProviderError extends DeepMemoryError {
  constructor(message: string, suggestion?: string, options?: ErrorOptions) {
    super(
      'PROVIDER_ERROR',
      message,
      suggestion ?? `Check provider configuration and connectivity.`,
      options,
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

/**
 * Thrown when a traversal (traverse, exploreNeighborhood, findPaths) runs
 * past its time limit: a client-side limit, or the storage
 * server's own transaction timeout. `timeoutMs` is the configured limit when
 * the provider knows it, otherwise the elapsed time observed before the server
 * ended the query. The backend error, when there is one, is `cause`.
 */
export class TraversalTimeoutError extends DeepMemoryError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, options?: ErrorOptions) {
    super(
      'TRAVERSAL_TIMEOUT',
      `Traversal timed out after ${timeoutMs}ms`,
      `The traversal was too large to finish in time; retrying it unchanged will time out again. Reduce the depth, add more specific filters, or lower the result limit.`,
      options,
    );
    this.name = 'TraversalTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when a non-traversal storage operation runs past the storage
 * server's transaction timeout. The server ends the query and rolls back its
 * transaction, so a timed-out write did not commit. The store itself is
 * healthy; the request was too large. The backend error is `cause`.
 */
export class QueryTimeoutError extends DeepMemoryError {
  readonly elapsedMs: number;

  constructor(elapsedMs: number, options?: ErrorOptions) {
    super(
      'QUERY_TIMEOUT',
      `Storage query timed out after ${elapsedMs}ms; the server ended it and rolled back its transaction`,
      `The request was too large to finish in time; retrying it unchanged will time out again. Narrow it with more specific filters, a smaller limit, or a smaller batch.`,
      options,
    );
    this.name = 'QueryTimeoutError';
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Thrown when a query is syntactically valid but the active provider cannot
 * execute it efficiently or correctly — e.g. a substring search on a backend
 * with no server-side text predicate, where the only safe implementation would
 * fan out across the entire partition. The caller should adjust the query
 * (add type filters, narrow the scope) or use a provider-specific alternative.
 */
export class UnsupportedQueryError extends DeepMemoryError {
  readonly provider: string;

  constructor(provider: string, message: string, suggestion?: string) {
    super('UNSUPPORTED_QUERY', message, suggestion);
    this.name = 'UnsupportedQueryError';
    this.provider = provider;
  }
}
