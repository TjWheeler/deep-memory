// Error mapping — driver `error.code` → typed errors from
// `packages/core/src/core/errors.ts`. Keyed off the documented Neo4j status
// code taxonomy (see D10 in plans/neo4j-provider.md and the P3 probe results
// at local-tests/baseline/neo4j-phase3-probes-results.md).
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
} from '@utaba/deep-memory';

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

/**
 * True when a driver error (or any error in its `cause` chain) reports that
 * the transaction was ended at its timeout. Matched structurally on
 * `gqlStatus` / `code` because only `Neo4jConnection` may import the driver.
 */
export function isTransactionTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth++) {
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
 * fired. Used so a constraint violation can be turned into a useful
 * `DuplicateEntityError(id)` / `DuplicateRelationshipError(id)` /
 * `DuplicateRepositoryError(id)` rather than a generic `ProviderError`.
 *
 * Callers pass whichever identifiers they already have in scope — the helper
 * picks the right typed error based on `kind`. When no id is available, the
 * helper falls back to `ProviderError` with the original code preserved in the
 * suggestion message.
 */
export interface DriverErrorContext {
  /** What the caller was operating on when the driver error fired. */
  kind?: 'entity' | 'relationship' | 'repository';
  /** Entity id (when `kind === 'entity'`). */
  entityId?: string;
  /** Relationship id (when `kind === 'relationship'`). */
  relationshipId?: string;
  /** Repository id (when `kind === 'repository'`). */
  repositoryId?: string;
  /** Free-form operation label (e.g. `'createEntity'`) — included in the message. */
  operation?: string;
}

interface DriverError {
  code?: unknown;
  message?: unknown;
}

/**
 * Convert a driver-thrown error into one of the project's typed errors.
 *
 * - `'Neo.ClientError.Schema.ConstraintValidationFailed'` →
 *   `DuplicateEntityError` / `DuplicateRelationshipError` /
 *   `DuplicateRepositoryError` based on `context.kind`. When `kind` is
 *   omitted, the helper inspects the constraint-violation message to pick
 *   the right branch (the message names the offending label —
 *   `_Repository` / `_Entity` / a relationship type — see probe P3).
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
  if (error instanceof DeepMemoryError) {
    throw error;
  }

  const driverError = (error ?? {}) as DriverError;
  const code = typeof driverError.code === 'string' ? driverError.code : '';
  const message = typeof driverError.message === 'string' ? driverError.message : '';

  if (code === CONSTRAINT_VIOLATION_CODE) {
    const kind = inferConstraintKind(context, message);
    if (kind === 'repository' && context.repositoryId !== undefined) {
      throw new DuplicateRepositoryError(context.repositoryId);
    }
    if (kind === 'entity' && context.entityId !== undefined) {
      throw new DuplicateEntityError(context.entityId);
    }
    if (kind === 'relationship' && context.relationshipId !== undefined) {
      throw new DuplicateRelationshipError(context.relationshipId);
    }
    throw new ProviderError(
      `Neo4j constraint violation${formatOperation(context)}: ${message || code}`,
      'Inspect the failing Cypher and the schema constraints — the affected unique key already exists.',
      { cause: error },
    );
  }

  if (code === SYNTAX_ERROR_CODE) {
    throw new ProviderError(
      `Neo4j syntax error${formatOperation(context)}: ${message || code}`,
      'This is a programming error inside @utaba/deep-memory-storage-neo4j — please file an issue.',
      { cause: error },
    );
  }

  const prefix = `Neo4j driver error${formatOperation(context)}`;
  const codeSuffix = code ? ` [${code}]` : '';
  const messageSuffix = message ? `: ${message}` : '';
  throw new ProviderError(`${prefix}${codeSuffix}${messageSuffix}`, undefined, { cause: error });
}

function inferConstraintKind(
  context: DriverErrorContext,
  message: string,
): 'entity' | 'relationship' | 'repository' {
  if (context.kind !== undefined) return context.kind;
  // Neo4j formats constraint-violation messages as
  //   "Node(...) already exists with label `_Entity` ..." OR
  //   "Node(...) already exists with label `_Repository` ..." OR
  //   "Relationship(...) already exists with type `KNOWS` ..."
  // We discriminate on the leading noun and (for nodes) the label embedded in
  // the message. Probe P3 captured the exact format on neo4j:5.26-community.
  if (message.startsWith('Relationship')) return 'relationship';
  if (message.includes('`_Repository`')) return 'repository';
  return 'entity';
}

function formatOperation(context: DriverErrorContext): string {
  return context.operation ? ` in ${context.operation}` : '';
}
