// Unique-key violation mapping — SQL Server error 2627 / 2601 → typed errors
// from `@utaba/deep-memory`, keyed by the constraint or index that fired.
//
// The create paths check for an existing id before inserting, and an update
// may move an entity onto a new slug, but the check and the write are
// separate statements: a concurrent writer can take the key in between. The
// INSERT or UPDATE then fails on a primary key or on `ix_dm_entities_slug`,
// and this helper turns that failure into the typed error the contract
// promises (SlugConflictError for a slug, which the engine retries with the
// next free slug; Duplicate*Error for an id), with the SQL Server error as
// `cause`.

import {
  DuplicateEntityError,
  ImportError,
  ProviderError,
  DuplicateRelationshipError,
  DuplicateRepositoryError,
  SlugConflictError,
} from '@utaba/deep-memory';
import type { DeepMemoryError, InvalidInputError } from '@utaba/deep-memory';

/** Violation of a PRIMARY KEY or UNIQUE constraint. */
const UNIQUE_CONSTRAINT_VIOLATION = 2627;
/** Duplicate key row in a unique index. */
const UNIQUE_INDEX_VIOLATION = 2601;

// SQL Server names the constraint or index before "The duplicate key value
// is (...)", which carries caller data; only the leading name is read.
const CONSTRAINT_NAME_PATTERN = /^Violation of (?:PRIMARY|UNIQUE) KEY constraint '([^']+)'/;
const INDEX_NAME_PATTERN = /^Cannot insert duplicate key row in object '[^']*' with unique index '([^']+)'/;

/** What the failing write was storing — the fields the typed error needs. */
export type UniqueViolationContext =
  | { kind: 'entity'; entityId: string; slug: string; entityType: string; label: string }
  | { kind: 'relationship'; relationshipId: string }
  | { kind: 'repository'; repositoryId: string };

/**
 * The unique keys on each table a create or update writes, by the error
 * number a violation of each raises. A table has at most one key per number
 * (`uq_dm_entities_ft_key` is filled from an IDENTITY, so it never clashes),
 * which lets the number stand in for the name when the server's message is
 * localised and the name cannot be read.
 */
export const UNIQUE_KEYS_BY_TABLE: Readonly<
  Record<UniqueViolationContext['kind'], Readonly<Partial<Record<number, string>>>>
> = {
  entity: { [UNIQUE_CONSTRAINT_VIOLATION]: 'pk_dm_entities', [UNIQUE_INDEX_VIOLATION]: 'ix_dm_entities_slug' },
  relationship: { [UNIQUE_CONSTRAINT_VIOLATION]: 'pk_dm_relationships' },
  repository: { [UNIQUE_CONSTRAINT_VIOLATION]: 'pk_dm_repositories' },
};

interface SqlErrorShape {
  number?: unknown;
  message?: unknown;
  originalError?: { info?: { number?: unknown; message?: unknown } };
}

/** A unique-key violation: its error number, and the key name when the message names it. */
export interface UniqueViolation {
  number: number;
  key?: string;
}

/** Number and message of a SQL Server error, from whichever shape carries them. */
function readSqlError(error: unknown): { number?: unknown; message?: unknown } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const shape = error as SqlErrorShape;
  // `mssql` copies the server's number and message onto its RequestError;
  // read the driver's own `info` when the error was not built that way.
  return typeof shape.number === 'number' ? shape : shape.originalError?.info;
}

/** A FOREIGN KEY (or CHECK / REFERENCE) constraint conflict. */
const FOREIGN_KEY_VIOLATION = 547;

/**
 * True when a write conflicted with a foreign-key constraint. The number is
 * shared by every foreign key on the table (and by CHECK constraints), and
 * the message that names the key may be localised, so the caller re-reads
 * the referenced rows to name the cause rather than trusting the message.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  return readSqlError(error)?.number === FOREIGN_KEY_VIOLATION;
}

/** The unique-key violation a SQL Server error reports, or `undefined` for any other error. */
export function readUniqueViolation(error: unknown): UniqueViolation | undefined {
  const source = readSqlError(error);
  const number = source?.number;
  if (number !== UNIQUE_CONSTRAINT_VIOLATION && number !== UNIQUE_INDEX_VIOLATION) return undefined;
  const message = typeof source?.message === 'string' ? source.message : '';
  const pattern = number === UNIQUE_CONSTRAINT_VIOLATION ? CONSTRAINT_NAME_PATTERN : INDEX_NAME_PATTERN;
  return { number, key: pattern.exec(message)?.[1] };
}

/**
 * The typed error for a unique-key violation raised by a write, keeping the
 * SQL Server error as `cause`; `undefined` when `error` is not a violation
 * of a key that `context` describes. The key is read from the message, or —
 * when the message is localised — inferred from the error number and the
 * table the write targeted.
 */
export function mapUniqueViolation(
  error: unknown,
  context: UniqueViolationContext,
): DeepMemoryError | undefined {
  const violation = readUniqueViolation(error);
  if (violation === undefined) return undefined;
  const key = violation.key ?? UNIQUE_KEYS_BY_TABLE[context.kind][violation.number];
  const options: ErrorOptions = { cause: error };
  switch (context.kind) {
    case 'entity':
      if (key === 'ix_dm_entities_slug') {
        return new SlugConflictError(
          context.slug,
          { entityType: context.entityType, label: context.label },
          options,
        );
      }
      return key === 'pk_dm_entities' ? new DuplicateEntityError(context.entityId, options) : undefined;
    case 'relationship':
      return key === 'pk_dm_relationships'
        ? new DuplicateRelationshipError(context.relationshipId, options)
        : undefined;
    case 'repository':
      return key === 'pk_dm_repositories'
        ? new DuplicateRepositoryError(context.repositoryId, options)
        : undefined;
  }
}

/** The row an import is writing, and what its typed error needs. */
export interface ImportRow {
  item: string;
  context: UniqueViolationContext;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A row's typed refusal raised by the import itself (a relationship id
 * already stored on another edge) rather than by SQL Server.
 */
function rowRefusal(err: unknown): DeepMemoryError | undefined {
  return err instanceof DuplicateEntityError ||
    err instanceof DuplicateRelationshipError ||
    err instanceof SlugConflictError
    ? err
    : undefined;
}

/**
 * The error an import rejects with after rolling back. A refused row (a
 * unique-key clash, or a clash the import detected itself) becomes an
 * ImportError naming the row, with the typed clash (Duplicate*Error /
 * SlugConflictError) as `cause`; any other failure a ProviderError with the
 * underlying error as `cause`.
 */
export function importFailure(err: unknown, row: ImportRow | undefined, rollbackError: unknown): DeepMemoryError {
  const rollbackNote =
    rollbackError === undefined ? '' : ` (the rollback also failed: ${errorMessage(rollbackError)})`;
  const suggestion = 'Nothing from this import was written. Fix the row and re-run the import.';
  const clash = row === undefined ? undefined : rowRefusal(err) ?? mapUniqueViolation(err, row.context);
  if (row !== undefined && clash !== undefined) {
    return new ImportError(
      `SQL Server import rolled back: ${row.item} failed: ${clash.message}${rollbackNote}`,
      suggestion,
      { cause: clash },
    );
  }
  const where = row === undefined ? 'the commit failed' : `${row.item} failed`;
  return new ProviderError(
    `SQL Server import rolled back: ${where}: ${errorMessage(err)}${rollbackNote}`,
    suggestion,
    { cause: err },
  );
}

/**
 * The error an import rejects with when a row is refused before anything is
 * written (a property key that cannot be stored): an ImportError naming the
 * row, with the row's InvalidInputError as `cause`, so a refusal caught up
 * front reads the same as one that rolls the import back.
 */
export function importRowRejected(row: ImportRow, refusal: InvalidInputError): ImportError {
  return new ImportError(
    `SQL Server import refused: ${row.item} failed: ${refusal.message}`,
    'Nothing from this import was written. Fix the row and re-run the import.',
    { cause: refusal },
  );
}
