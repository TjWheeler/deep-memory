// Error mapping — driver `error.code` → typed errors from
// `packages/core/src/core/errors.ts`, keyed off the documented Neo4j status
// code taxonomy.
//
// The "not found" cases are NOT handled here — they come from result-set
// inspection by individual callers (e.g. a `MATCH ... SET ... RETURN n` that
// returns zero rows). This helper only translates driver-level error codes.

import {
  DeepMemoryError,
  DuplicateEntityError,
  DuplicateRelationshipError,
  DuplicateRepositoryError,
  ProviderError,
  SlugConflictError,
} from '@utaba/deep-memory';
import type { DeepMemoryErrorCode } from '@utaba/deep-memory';

const CONSTRAINT_VIOLATION_CODE = 'Neo.ClientError.Schema.ConstraintValidationFailed';
const SYNTAX_ERROR_CODE = 'Neo.ClientError.Statement.SyntaxError';
/** GQL status the server reports when it ends a transaction at its timeout. */
const TRANSACTION_TIMEOUT_GQL_STATUS = '25N14';
/**
 * Fragment shared by the legacy status codes for a timed-out transaction
 * (`…Transaction.TransactionTimedOut` for the server's `db.transaction.timeout`,
 * `…TransactionTimedOutClientConfiguration` for a client-set timeout).
 */
const TRANSACTION_TIMEOUT_CODE_FRAGMENT = 'TransactionTimedOut';
/** How far down a `cause` chain the structural matchers look. */
const MAX_CAUSE_DEPTH = 8;

/**
 * True when a driver error (or any error in its `cause` chain) reports that
 * the transaction was ended at its timeout. Matched structurally on
 * `gqlStatus` / `code` because only `Neo4jConnection` may import the driver.
 */
export function isTransactionTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === 'object' && current !== null; depth++) {
    const candidate = current as { gqlStatus?: unknown; code?: unknown; cause?: unknown };
    if (candidate.gqlStatus === TRANSACTION_TIMEOUT_GQL_STATUS) return true;
    if (
      typeof candidate.code === 'string' &&
      candidate.code.includes(TRANSACTION_TIMEOUT_CODE_FRAGMENT)
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/**
 * Context describing what the caller was trying to do when the driver error
 * fired. A constraint violation is mapped by the constraint that fired; the
 * ids in scope supply the fields of the resulting typed error
 * (`DuplicateEntityError(entityId)`, `SlugConflictError(slug)`, ...).
 *
 * Callers pass whichever identifiers they already have in scope. When the
 * error does not identify the constraint, `kind` picks the branch instead.
 * When the id the branch needs is missing, the helper falls back to
 * `ProviderError` with the driver error as `cause`.
 */
export interface DriverErrorContext {
  /**
   * What the caller was operating on. Consulted only when the driver error
   * does not identify the constraint; `'entity'` then means an id clash.
   */
  kind?: 'entity' | 'relationship' | 'repository';
  /** Entity id (for an entity id clash). */
  entityId?: string;
  /** Entity slug (for an entity slug clash). */
  slug?: string;
  /** Entity type, carried onto `SlugConflictError`. */
  entityType?: string;
  /** Entity label, carried onto `SlugConflictError`. */
  label?: string;
  /** Relationship id (for a relationship id clash). */
  relationshipId?: string;
  /** Repository id (for a repository clash). */
  repositoryId?: string;
  /** Free-form operation label (e.g. `'createEntity'`) — included in the message. */
  operation?: string;
}

/** Which uniqueness rule a constraint violation broke. */
type ConstraintTarget = 'entity-id' | 'entity-slug' | 'repository' | 'relationship';

/**
 * The node uniqueness constraints `ensureSchema` creates (see `schema.ts`),
 * with the label and the distinguishing key each one covers. The driver
 * message for a violation names the label and keys but not the constraint,
 * so those identify it; the name is matched for messages in other shapes.
 */
const NODE_UNIQUENESS_CONSTRAINTS: ReadonlyArray<{
  name: string;
  label: string;
  key: string;
  target: ConstraintTarget;
}> = [
  { name: 'dm_entity_unique', label: '_Entity', key: 'id', target: 'entity-id' },
  { name: 'dm_entity_slug_unique', label: '_Entity', key: 'slug', target: 'entity-slug' },
  { name: 'dm_repository_unique', label: '_Repository', key: 'repositoryId', target: 'repository' },
];

/** Exported for the test that keeps this table in step with the schema DDL. */
export const NODE_UNIQUENESS_CONSTRAINT_NAMES: readonly string[] = NODE_UNIQUENESS_CONSTRAINTS.map(
  (c) => c.name,
);

// Neo4j formats a node uniqueness violation as
//   Node(<n>) already exists with label `<label>` and property `<k>` = <v>
//   Node(<n>) already exists with label `<label>` and properties `<k1>` = <v1>, `<k2>` = <v2>
// listing the keys in constraint order. Every entity constraint leads with
// `repositoryId`, whose value is quote-free, so the key after it is read
// unambiguously; the trailing value is caller data and is never parsed.
const NODE_VIOLATION_PATTERN =
  /^Node\(\d+\) already exists with label `([^`]+)` and propert(?:y|ies) `([^`]+)` = (?:'[^']*', `([^`]+)` = )?/;

interface DriverError {
  code?: unknown;
  message?: unknown;
}

/**
 * Convert a driver-thrown error into one of the project's typed errors.
 *
 * - `'Neo.ClientError.Schema.ConstraintValidationFailed'` → mapped by the
 *   constraint that fired: `dm_entity_unique` → `DuplicateEntityError`,
 *   `dm_entity_slug_unique` → `SlugConflictError`, `dm_repository_unique` →
 *   `DuplicateRepositoryError`, a relationship violation →
 *   `DuplicateRelationshipError`. The constraint is identified from the
 *   driver error (the label and key in the message, else a constraint name
 *   in a part of the error that carries no caller data);
 *   `context.kind` decides only when the error does not say. Every one keeps
 *   the driver error as `cause`.
 * - `'Neo.ClientError.Statement.SyntaxError'` → `ProviderError` (programming
 *   bug in this package; should never surface to end users).
 * - Anything else → `ProviderError` with the original error attached as
 *   `cause` so root-cause analysis still works.
 *
 * Re-throws inputs that are already instances of the project's typed error
 * hierarchy unchanged — including the `QueryTimeoutError` that
 * `Neo4jConnection` raises for a server-side transaction timeout.
 */
export function mapDriverError(error: unknown, context: DriverErrorContext = {}): never {
  throw toTypedError(error, context);
}

/**
 * The value of a settled statement, or its failure raised through
 * `mapDriverError`. Parallel statements settle together so the caller can
 * read the one carrying the repository marker check first: a missing
 * repository is then reported ahead of a failure of a sibling statement.
 */
export function settledValue<T>(result: PromiseSettledResult<T>, context: DriverErrorContext = {}): T {
  if (result.status === 'rejected') mapDriverError(result.reason, context);
  return result.value;
}

/**
 * The typed error `mapDriverError` throws for `error`, returned instead of
 * thrown — for recording a failure (e.g. one bulk-import row) and carrying on.
 */
export function toTypedError(error: unknown, context: DriverErrorContext = {}): DeepMemoryError {
  if (error instanceof DeepMemoryError) {
    return error;
  }

  const driverError = (error ?? {}) as DriverError;
  const code = typeof driverError.code === 'string' ? driverError.code : '';
  const message = typeof driverError.message === 'string' ? driverError.message : '';

  if (code === CONSTRAINT_VIOLATION_CODE) {
    const target = identifyConstraint(error, message) ?? targetFromKind(context.kind);
    const duplicate = buildDuplicateError(target, context, { cause: error });
    if (duplicate !== undefined) return duplicate;
    return new ProviderError(
      `Neo4j constraint violation${formatOperation(context)}: ${message || code}`,
      'Inspect the failing Cypher and the schema constraints — the affected unique key already exists.',
      { cause: error },
    );
  }

  if (code === SYNTAX_ERROR_CODE) {
    return new ProviderError(
      `Neo4j syntax error${formatOperation(context)}: ${message || code}`,
      'This is a programming error inside @utaba/deep-memory-storage-neo4j — please file an issue.',
      { cause: error },
    );
  }

  const prefix = `Neo4j driver error${formatOperation(context)}`;
  const codeSuffix = code ? ` [${code}]` : '';
  const messageSuffix = message ? `: ${message}` : '';
  return new ProviderError(`${prefix}${codeSuffix}${messageSuffix}`, undefined, { cause: error });
}

/**
 * True when `error` is a uniqueness violation that `toTypedError` maps, for
 * an entity write, to `DuplicateEntityError` (the id) or `SlugConflictError`
 * (the slug). For a write that carries many entities and so has no single
 * id or slug to put on the typed error.
 */
export function isEntityUniquenessViolation(error: unknown): boolean {
  if (error instanceof DuplicateEntityError || error instanceof SlugConflictError) return true;
  if (error instanceof DeepMemoryError) return false;
  const driverError = (error ?? {}) as DriverError;
  if (driverError.code !== CONSTRAINT_VIOLATION_CODE) return false;
  const message = typeof driverError.message === 'string' ? driverError.message : '';
  const target = identifyConstraint(error, message) ?? targetFromKind('entity');
  return target === 'entity-id' || target === 'entity-slug';
}

/**
 * The typed error for a violated uniqueness rule, or `undefined` when the id
 * that error needs is not in the caller's context.
 */
function buildDuplicateError(
  target: ConstraintTarget | undefined,
  context: DriverErrorContext,
  options: ErrorOptions,
): DeepMemoryError | undefined {
  switch (target) {
    case 'entity-id':
      return context.entityId !== undefined
        ? new DuplicateEntityError(context.entityId, options)
        : undefined;
    case 'entity-slug':
      return context.slug !== undefined
        ? new SlugConflictError(
            context.slug,
            { entityType: context.entityType, label: context.label },
            options,
          )
        : undefined;
    case 'repository':
      return context.repositoryId !== undefined
        ? new DuplicateRepositoryError(context.repositoryId, options)
        : undefined;
    case 'relationship':
      return context.relationshipId !== undefined
        ? new DuplicateRelationshipError(context.relationshipId, options)
        : undefined;
    case undefined:
      return undefined;
  }
}

/**
 * Identify the violated constraint from the driver error alone, or
 * `undefined` when it does not say.
 *
 * The label and key in a recognised violation message are read first: they
 * precede every caller-supplied value in the message, so an id or slug that
 * happens to spell a constraint name cannot steer the result. For a message
 * in any other shape, a constraint name is looked for only where no caller
 * value can appear — a message cut at its first `` `key` = `` value, and
 * `gqlStatusDescription` — across the error and its `cause` chain. Names
 * of more than one constraint leave the violation unidentified.
 */
function identifyConstraint(error: unknown, message: string): ConstraintTarget | undefined {
  const match = NODE_VIOLATION_PATTERN.exec(message);
  if (match !== null) {
    const [, label, firstKey, secondKey] = match;
    // Composite constraints name `repositoryId` first and the distinguishing
    // key second; a single-key constraint names only its own key.
    const key = secondKey ?? firstKey;
    const byShape = NODE_UNIQUENESS_CONSTRAINTS.find((c) => c.label === label && c.key === key);
    if (byShape !== undefined) return byShape.target;
  }

  if (message.startsWith('Relationship(')) return 'relationship';

  const texts = collectValueFreeTexts(error);
  const named = new Set<ConstraintTarget>();
  for (const constraint of NODE_UNIQUENESS_CONSTRAINTS) {
    const byName = new RegExp(`\\b${constraint.name}\\b`);
    if (texts.some((text) => byName.test(text))) named.add(constraint.target);
  }
  if (named.size !== 1) return undefined;
  const [target] = named;
  return target;
}

/** Marks the start of the first property value in a violation message. */
const FIRST_VALUE_MARKER = '` = ';

/**
 * Texts of an error and its `cause` chain that carry no caller data: each
 * `message` cut at its first property value, and each `gqlStatusDescription`.
 */
function collectValueFreeTexts(error: unknown): string[] {
  const texts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === 'object' && current !== null; depth++) {
    const candidate = current as { message?: unknown; gqlStatusDescription?: unknown; cause?: unknown };
    if (typeof candidate.message === 'string') {
      const valueStart = candidate.message.indexOf(FIRST_VALUE_MARKER);
      texts.push(valueStart === -1 ? candidate.message : candidate.message.slice(0, valueStart));
    }
    if (typeof candidate.gqlStatusDescription === 'string') texts.push(candidate.gqlStatusDescription);
    current = candidate.cause;
  }
  return texts;
}

function targetFromKind(kind: DriverErrorContext['kind']): ConstraintTarget | undefined {
  switch (kind) {
    case 'entity':
      return 'entity-id';
    case 'relationship':
      return 'relationship';
    case 'repository':
      return 'repository';
    case undefined:
      return undefined;
  }
}

/** Driver codes caused by the contents of one row rather than by the store. */
const ROW_SHAPED_DRIVER_CODES: ReadonlySet<string> = new Set([
  CONSTRAINT_VIOLATION_CODE,
  // A value the server cannot store or compare (e.g. a nested map property).
  'Neo.ClientError.Statement.TypeError',
  'Neo.ClientError.Statement.ArgumentError',
  // Raised when a MERGE key evaluates to null (a row missing its id). The
  // statement itself is valid, and the same query succeeds for other rows,
  // so the fault belongs to that row.
  'Neo.ClientError.Statement.SemanticError',
]);

/** Typed-error codes that describe one row's contents. */
const ROW_SHAPED_ERROR_CODES: ReadonlySet<DeepMemoryErrorCode> = new Set<DeepMemoryErrorCode>([
  'INVALID_INPUT',
  'VOCABULARY_VALIDATION_FAILED',
  'ENTITY_ALREADY_EXISTS',
  'RELATIONSHIP_ALREADY_EXISTS',
  'SLUG_CONFLICT',
]);

/**
 * True when a write failed because of the rows it carried — a uniqueness
 * clash or a value the server refused — so retrying the rows one at a time
 * isolates the bad ones. False for failures of the store itself (a timeout,
 * an unavailable or expired connection, a security or database error), where
 * retrying row by row would only multiply the load on a failing store.
 */
export function isRowShapedFailure(error: unknown): boolean {
  if (error instanceof DeepMemoryError) return ROW_SHAPED_ERROR_CODES.has(error.code);
  const code = (error as DriverError | null | undefined)?.code;
  return typeof code === 'string' && ROW_SHAPED_DRIVER_CODES.has(code);
}

/**
 * Status code for a transaction that exceeded the per-transaction memory
 * limit (`db.memory.transaction.max`). The limit is a property of the one
 * transaction, so a smaller write can succeed.
 */
export const TRANSACTION_MEMORY_LIMIT_CODE = 'Neo.TransientError.General.TransactionMemoryLimit';

/**
 * Status code for a transaction refused because the server-wide transaction
 * memory pool (`dbms.memory.transaction.total.max`) is exhausted — a state
 * of the whole store, shared with every other transaction.
 */
export const MEMORY_POOL_EXHAUSTED_CODE = 'Neo.TransientError.General.MemoryPoolOutOfMemoryError';

function driverCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as DriverError).code;
  return typeof code === 'string' ? code : undefined;
}

/** True when a write exceeded the per-transaction memory limit. */
export function isTransactionMemoryLimit(error: unknown): boolean {
  return driverCode(error) === TRANSACTION_MEMORY_LIMIT_CODE;
}

/**
 * True when a write ran out of transaction memory, at either the
 * per-transaction limit or the server-wide pool. Either can be caused by the
 * size of a multi-row write, so a smaller write is worth trying.
 */
export function isMemoryLimitFailure(error: unknown): boolean {
  const code = driverCode(error);
  return code === TRANSACTION_MEMORY_LIMIT_CODE || code === MEMORY_POOL_EXHAUSTED_CODE;
}

/**
 * Status code for a statement that wrote to a node or relationship another
 * transaction deleted while the statement waited for its lock. The server
 * releases the lock on a deleted node to the waiter, and a server version
 * may refuse the waiter's write instead of applying it to the deleted node.
 */
export const DELETED_ENTITY_CODE = 'Neo.ClientError.Statement.EntityNotFound';

/**
 * True when a statement touched a node or relationship that a concurrent
 * transaction deleted. The error does not say which one, so the caller looks
 * again before naming the cause.
 */
export function isDeletedEntityFailure(error: unknown): boolean {
  return driverCode(error) === DELETED_ENTITY_CODE;
}

function formatOperation(context: DriverErrorContext): string {
  return context.operation ? ` in ${context.operation}` : '';
}
