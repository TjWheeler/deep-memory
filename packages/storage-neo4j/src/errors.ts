// Error mapping — driver `error.code` → typed errors from
// `packages/core/src/core/errors.ts`. Keyed off the documented Neo4j status
// code taxonomy (see D10 in plans/neo4j-provider.md and the P3 probe results
// at local-tests/baseline/neo4j-phase3-probes-results.md).
//
// The "not found" cases are NOT handled here — they come from result-set
// inspection by individual callers (e.g. a `MATCH ... SET ... RETURN n` that
// returns zero rows). This helper only translates driver-level error codes.

import {
  DuplicateEntityError,
  DuplicateRelationshipError,
  ProviderError,
} from '@utaba/deep-memory';

const CONSTRAINT_VIOLATION_CODE = 'Neo.ClientError.Schema.ConstraintValidationFailed';
const SYNTAX_ERROR_CODE = 'Neo.ClientError.Statement.SyntaxError';

/**
 * Context describing what the caller was trying to do when the driver error
 * fired. Used so a constraint violation can be turned into a useful
 * `DuplicateEntityError(id)` / `DuplicateRelationshipError(id)` rather than a
 * generic `ProviderError`.
 *
 * Callers pass whichever identifiers they already have in scope — the helper
 * picks the right typed error based on `kind`. When neither id is available,
 * the helper falls back to `ProviderError` with the original code preserved
 * in the suggestion message.
 */
export interface DriverErrorContext {
  /** What the caller was operating on when the driver error fired. */
  kind?: 'entity' | 'relationship';
  /** Entity id (when `kind === 'entity'`). */
  entityId?: string;
  /** Relationship id (when `kind === 'relationship'`). */
  relationshipId?: string;
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
 * - `'Neo.ClientError.Schema.ConstraintValidationFailed'` → `DuplicateEntityError`
 *   or `DuplicateRelationshipError` based on `context.kind` (the only Neo4j
 *   uniqueness constraints we declare are entity-level — see D7 — so the
 *   `entity` branch is the practical hot path; the `relationship` branch
 *   exists for forward compatibility with any future per-type relationship
 *   constraint).
 * - `'Neo.ClientError.Statement.SyntaxError'` → `ProviderError` (programming
 *   bug in this package; should never surface to end users).
 * - Anything else → `ProviderError` with the original error attached as
 *   `cause` so root-cause analysis still works.
 *
 * Re-throws inputs that are already instances of the project's typed error
 * hierarchy unchanged.
 */
export function mapDriverError(error: unknown, context: DriverErrorContext = {}): never {
  if (
    error instanceof DuplicateEntityError ||
    error instanceof DuplicateRelationshipError ||
    error instanceof ProviderError
  ) {
    throw error;
  }

  const driverError = (error ?? {}) as DriverError;
  const code = typeof driverError.code === 'string' ? driverError.code : '';
  const message = typeof driverError.message === 'string' ? driverError.message : '';

  if (code === CONSTRAINT_VIOLATION_CODE) {
    const kind = inferConstraintKind(context, message);
    if (kind === 'entity' && context.entityId !== undefined) {
      throw new DuplicateEntityError(context.entityId);
    }
    if (kind === 'relationship' && context.relationshipId !== undefined) {
      throw new DuplicateRelationshipError(context.relationshipId);
    }
    throw new ProviderError(
      `Neo4j constraint violation${formatOperation(context)}: ${message || code}`,
      'Inspect the failing Cypher and the schema constraints — the affected (repositoryId, id) or (repositoryId, slug) pair already exists.',
    );
  }

  if (code === SYNTAX_ERROR_CODE) {
    throw new ProviderError(
      `Neo4j syntax error${formatOperation(context)}: ${message || code}`,
      'This is a programming error inside @utaba/deep-memory-storage-neo4j — please file an issue.',
    );
  }

  const prefix = `Neo4j driver error${formatOperation(context)}`;
  const codeSuffix = code ? ` [${code}]` : '';
  const messageSuffix = message ? `: ${message}` : '';
  throw new ProviderError(`${prefix}${codeSuffix}${messageSuffix}`);
}

function inferConstraintKind(
  context: DriverErrorContext,
  message: string,
): 'entity' | 'relationship' {
  if (context.kind === 'relationship') return 'relationship';
  if (context.kind === 'entity') return 'entity';
  // Neo4j formats constraint-violation messages as
  //   "Node(...) already exists with label `_Entity` ..." OR
  //   "Relationship(...) already exists with type `KNOWS` ..."
  // We discriminate on the leading noun. No context.kind means the caller did
  // not know — best-effort inference from the message text.
  if (message.startsWith('Relationship')) return 'relationship';
  return 'entity';
}

function formatOperation(context: DriverErrorContext): string {
  return context.operation ? ` in ${context.operation}` : '';
}
