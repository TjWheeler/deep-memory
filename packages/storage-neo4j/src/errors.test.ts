import { describe, expect, it } from 'vitest';
import {
  DeepMemoryError,
  DuplicateEntityError,
  DuplicateRelationshipError,
  DuplicateRepositoryError,
  InvalidInputError,
  ProviderError,
  QueryTimeoutError,
  SlugConflictError,
} from '@utaba/deep-memory';
import {
  isEntityUniquenessViolation,
  isMemoryLimitFailure,
  isRetryableTransientFailure,
  isRowShapedFailure,
  isTransactionMemoryLimit,
  isTransactionTimeout,
  MEMORY_POOL_EXHAUSTED_CODE,
  TRANSACTION_MEMORY_LIMIT_CODE,
  mapDriverError,
  NODE_UNIQUENESS_CONSTRAINT_NAMES,
  toTypedError,
} from './errors.js';
import { getSchemaCypher } from './schema.js';

const CONSTRAINT_VIOLATION = 'Neo.ClientError.Schema.ConstraintValidationFailed';

function fakeDriverError(code: string, message: string, extra: Record<string, unknown> = {}): unknown {
  // Mirror the surface used by `neo4j-driver`'s Neo4jError: an object with
  // string-typed `code` and `message`.
  return { name: 'Neo4jError', code, message, ...extra };
}

// Violation messages in the exact format a Neo4j 5 server returns for the
// three node uniqueness constraints `ensureSchema` creates.
const ID_VIOLATION =
  "Node(10708) already exists with label `_Entity` and properties `repositoryId` = 'r1', `id` = 'e1'";
const SLUG_VIOLATION =
  "Node(10708) already exists with label `_Entity` and properties `repositoryId` = 'r1', `slug` = 'person:alex'";
const REPOSITORY_VIOLATION =
  "Node(10721) already exists with label `_Repository` and property `repositoryId` = 'r1'";

/** Run `mapDriverError` and return what it threw. */
function mapped(error: unknown, context: Parameters<typeof mapDriverError>[1] = {}): DeepMemoryError {
  try {
    mapDriverError(error, context);
  } catch (thrown) {
    if (thrown instanceof DeepMemoryError) return thrown;
    throw thrown;
  }
  throw new Error('mapDriverError returned');
}

const ENTITY_CONTEXT = {
  kind: 'entity' as const,
  entityId: 'e1',
  slug: 'person:alex',
  entityType: 'person',
  label: 'Alex',
  operation: 'createEntity',
};

describe('mapDriverError', () => {
  describe('constraint violations are mapped by the constraint that fired', () => {
    it('maps the entity id constraint to DuplicateEntityError', () => {
      const err = fakeDriverError(CONSTRAINT_VIOLATION, ID_VIOLATION);
      const result = mapped(err, ENTITY_CONTEXT);
      expect(result).toBeInstanceOf(DuplicateEntityError);
      expect((result as DuplicateEntityError).id).toBe('e1');
    });

    it('maps the entity slug constraint to SlugConflictError even with entity context', () => {
      const err = fakeDriverError(CONSTRAINT_VIOLATION, SLUG_VIOLATION);
      const result = mapped(err, ENTITY_CONTEXT);
      expect(result).toBeInstanceOf(SlugConflictError);
      expect(result).toMatchObject({
        code: 'SLUG_CONFLICT',
        slug: 'person:alex',
        entityType: 'person',
        label: 'Alex',
      });
    });

    it('maps the repository constraint to DuplicateRepositoryError', () => {
      const err = fakeDriverError(CONSTRAINT_VIOLATION, REPOSITORY_VIOLATION);
      const result = mapped(err, { kind: 'repository', repositoryId: 'r1', operation: 'createRepository' });
      expect(result).toBeInstanceOf(DuplicateRepositoryError);
    });

    it('maps the change-log constraint to ProviderError, whatever context.kind says', () => {
      const err = fakeDriverError(
        CONSTRAINT_VIOLATION,
        "Node(10730) already exists with label `_VocabularyChangeLog` and properties `repositoryId` = 'r1', `changeId` = 'c1'",
      );
      const result = mapped(err, ENTITY_CONTEXT);
      expect(result).toBeInstanceOf(ProviderError);
      expect(result.cause).toBe(err);
    });

    it('prefers the constraint in the message over a conflicting context.kind', () => {
      const err = fakeDriverError(CONSTRAINT_VIOLATION, REPOSITORY_VIOLATION);
      const result = mapped(err, { kind: 'entity', entityId: 'e1', repositoryId: 'r1' });
      expect(result).toBeInstanceOf(DuplicateRepositoryError);
    });

    it('is not steered by a caller value that spells a constraint name', () => {
      const err = fakeDriverError(
        CONSTRAINT_VIOLATION,
        "Node(1) already exists with label `_Entity` and properties `repositoryId` = 'r1', `id` = 'dm_entity_slug_unique'",
      );
      const result = mapped(err, { ...ENTITY_CONTEXT, entityId: 'dm_entity_slug_unique' });
      expect(result).toBeInstanceOf(DuplicateEntityError);
    });

    it('reads a constraint name when the message is in another shape', () => {
      const slugByName = fakeDriverError(
        CONSTRAINT_VIOLATION,
        'Uniqueness violated',
        { cause: { message: 'constraint `dm_entity_slug_unique` violated' } },
      );
      expect(mapped(slugByName, ENTITY_CONTEXT)).toBeInstanceOf(SlugConflictError);

      const idByName = fakeDriverError(CONSTRAINT_VIOLATION, 'Constraint dm_entity_unique violated');
      expect(mapped(idByName, ENTITY_CONTEXT)).toBeInstanceOf(DuplicateEntityError);

      const repoByName = fakeDriverError(CONSTRAINT_VIOLATION, 'Constraint dm_repository_unique violated');
      expect(mapped(repoByName, { repositoryId: 'r1' })).toBeInstanceOf(DuplicateRepositoryError);
    });

    it('ignores a constraint name that appears only in a value of an unrecognised message', () => {
      const err = fakeDriverError(
        CONSTRAINT_VIOLATION,
        "Uniqueness violated on `_Thing` with `name` = 'dm_entity_slug_unique'",
      );
      // Unidentified, so context.kind decides: an id clash.
      expect(mapped(err, ENTITY_CONTEXT)).toBeInstanceOf(DuplicateEntityError);
    });

    it('reads a constraint name from gqlStatusDescription', () => {
      const err = fakeDriverError(CONSTRAINT_VIOLATION, 'Uniqueness violated', {
        gqlStatusDescription: 'error: constraint dm_entity_slug_unique violated',
      });
      expect(mapped(err, ENTITY_CONTEXT)).toBeInstanceOf(SlugConflictError);
    });

    it('treats names of more than one constraint as unidentified', () => {
      const err = fakeDriverError(
        CONSTRAINT_VIOLATION,
        'Constraints dm_entity_unique and dm_entity_slug_unique violated',
      );
      expect(mapped(err, { entityId: 'e1', slug: 'person:alex' })).toBeInstanceOf(ProviderError);
      expect(mapped(err, ENTITY_CONTEXT)).toBeInstanceOf(DuplicateEntityError);
    });

    it('identifies a relationship violation from the message', () => {
      const err = fakeDriverError(CONSTRAINT_VIOLATION, 'Relationship(0) already exists with type `KNOWS` ...');
      expect(mapped(err, { relationshipId: 'rel1' })).toBeInstanceOf(DuplicateRelationshipError);
    });
  });

  describe('falls back to context.kind when the error does not identify the constraint', () => {
    it('entity → DuplicateEntityError', () => {
      const err = fakeDriverError(CONSTRAINT_VIOLATION, 'Node(0) already exists');
      expect(mapped(err, ENTITY_CONTEXT)).toBeInstanceOf(DuplicateEntityError);
    });

    it('repository → DuplicateRepositoryError', () => {
      const err = fakeDriverError(CONSTRAINT_VIOLATION, 'Node(0) already exists');
      expect(mapped(err, { kind: 'repository', repositoryId: 'r1' })).toBeInstanceOf(DuplicateRepositoryError);
    });

    it('relationship → DuplicateRelationshipError', () => {
      const err = fakeDriverError(CONSTRAINT_VIOLATION, 'already exists');
      expect(mapped(err, { kind: 'relationship', relationshipId: 'rel1' })).toBeInstanceOf(
        DuplicateRelationshipError,
      );
    });

    it('no kind and no identification → ProviderError', () => {
      const err = fakeDriverError(CONSTRAINT_VIOLATION, 'Node(0) already exists');
      expect(mapped(err, { entityId: 'e1' })).toBeInstanceOf(ProviderError);
    });
  });

  it('keeps the driver error as cause on every duplicate it builds', () => {
    const cases: Array<[unknown, Parameters<typeof mapDriverError>[1]]> = [
      [fakeDriverError(CONSTRAINT_VIOLATION, ID_VIOLATION), ENTITY_CONTEXT],
      [fakeDriverError(CONSTRAINT_VIOLATION, SLUG_VIOLATION), ENTITY_CONTEXT],
      [fakeDriverError(CONSTRAINT_VIOLATION, REPOSITORY_VIOLATION), { repositoryId: 'r1' }],
      [fakeDriverError(CONSTRAINT_VIOLATION, 'Relationship(0) already exists'), { relationshipId: 'rel1' }],
    ];
    for (const [err, context] of cases) {
      expect(mapped(err, context).cause).toBe(err);
    }
  });

  it('falls back to ProviderError when the id the mapped error needs is not in scope', () => {
    const err = fakeDriverError(CONSTRAINT_VIOLATION, SLUG_VIOLATION);
    expect(mapped(err, { kind: 'entity', entityId: 'e1', operation: 'createEntity' })).toBeInstanceOf(
      ProviderError,
    );
  });

  it('maps Neo.ClientError.Statement.SyntaxError → ProviderError', () => {
    const err = fakeDriverError('Neo.ClientError.Statement.SyntaxError', "Invalid input 'MATTCH'");
    expect(() => mapDriverError(err)).toThrowError(ProviderError);
  });

  it('maps any other code → ProviderError with the original code in the message', () => {
    const err = fakeDriverError(
      'Neo.ClientError.Procedure.ProcedureNotFound',
      'There is no procedure with the name `x` registered',
    );
    expect(() => mapDriverError(err)).toThrow(/ProcedureNotFound/);
  });

  it('rethrows typed errors unchanged', () => {
    const original = new DuplicateEntityError('e1');
    expect(() => mapDriverError(original)).toThrowError(original);

    const repoErr = new DuplicateRepositoryError('r1');
    expect(() => mapDriverError(repoErr)).toThrowError(repoErr);
  });

  it('keeps the driver error as cause on every ProviderError it builds', () => {
    const errors = [
      fakeDriverError(CONSTRAINT_VIOLATION, 'Node(0) already exists'),
      fakeDriverError('Neo.ClientError.Statement.SyntaxError', 'bad'),
      fakeDriverError('Neo.TransientError.General.DatabaseUnavailable', 'down'),
    ];
    for (const err of errors) {
      const result = mapped(err, { operation: 'createEntity' });
      expect(result).toBeInstanceOf(ProviderError);
      expect(result.cause).toBe(err);
    }
  });

  it('rethrows QueryTimeoutError unchanged', () => {
    const timeout = new QueryTimeoutError(1000);
    expect(() => mapDriverError(timeout, { operation: 'createEntity' })).toThrowError(timeout);
  });

  it('handles errors that lack a code or message gracefully', () => {
    expect(() => mapDriverError({})).toThrowError(ProviderError);
    expect(() => mapDriverError(null)).toThrowError(ProviderError);
    expect(() => mapDriverError(undefined)).toThrowError(ProviderError);
  });
});

describe('toTypedError', () => {
  it('returns the error mapDriverError would throw', () => {
    const err = fakeDriverError(CONSTRAINT_VIOLATION, SLUG_VIOLATION);
    const result = toTypedError(err, ENTITY_CONTEXT);
    expect(result).toBeInstanceOf(SlugConflictError);
    expect(result.cause).toBe(err);
  });
});

describe('NODE_UNIQUENESS_CONSTRAINT_NAMES', () => {
  it('names every uniqueness constraint the schema creates', () => {
    const ddlNames = getSchemaCypher()
      .map((ddl) => /^CREATE CONSTRAINT (\w+)/.exec(ddl)?.[1])
      .filter((name): name is string => name !== undefined);
    expect([...NODE_UNIQUENESS_CONSTRAINT_NAMES].sort()).toEqual([...ddlNames].sort());
  });
});

describe('isRowShapedFailure', () => {
  it('accepts failures caused by a row', () => {
    expect(isRowShapedFailure(fakeDriverError(CONSTRAINT_VIOLATION, SLUG_VIOLATION))).toBe(true);
    expect(isRowShapedFailure(fakeDriverError('Neo.ClientError.Statement.TypeError', 'x'))).toBe(true);
    expect(isRowShapedFailure(fakeDriverError('Neo.ClientError.Statement.SemanticError', 'x'))).toBe(true);
    expect(isRowShapedFailure(new DuplicateEntityError('e1'))).toBe(true);
    expect(isRowShapedFailure(new SlugConflictError('s'))).toBe(true);
    expect(isRowShapedFailure(new InvalidInputError('properties.x', 'bad'))).toBe(true);
  });

  it('rejects failures of the store itself', () => {
    expect(isRowShapedFailure(new QueryTimeoutError(1000))).toBe(false);
    expect(isRowShapedFailure(new ProviderError('down'))).toBe(false);
    expect(isRowShapedFailure(fakeDriverError('ServiceUnavailable', 'Could not perform discovery'))).toBe(false);
    expect(isRowShapedFailure(fakeDriverError('SessionExpired', 'expired'))).toBe(false);
    expect(isRowShapedFailure(fakeDriverError('Neo.TransientError.General.DatabaseUnavailable', 'x'))).toBe(false);
    expect(isRowShapedFailure(fakeDriverError('Neo.ClientError.Statement.SyntaxError', 'x'))).toBe(false);
    expect(isRowShapedFailure(new Error('socket hang up'))).toBe(false);
    expect(isRowShapedFailure(null)).toBe(false);
  });
});

describe('isEntityUniquenessViolation', () => {
  it('accepts an entity id or slug violation, and the typed errors for them', () => {
    expect(isEntityUniquenessViolation(fakeDriverError(CONSTRAINT_VIOLATION, ID_VIOLATION))).toBe(true);
    expect(isEntityUniquenessViolation(fakeDriverError(CONSTRAINT_VIOLATION, SLUG_VIOLATION))).toBe(true);
    expect(isEntityUniquenessViolation(new DuplicateEntityError('e1'))).toBe(true);
    expect(isEntityUniquenessViolation(new SlugConflictError('s'))).toBe(true);
  });

  it('reads an unidentified violation as an entity id clash, as toTypedError does for an entity write', () => {
    expect(isEntityUniquenessViolation(fakeDriverError(CONSTRAINT_VIOLATION, 'constraint violated'))).toBe(true);
  });

  it('rejects other constraints and other failures', () => {
    expect(isEntityUniquenessViolation(fakeDriverError(CONSTRAINT_VIOLATION, REPOSITORY_VIOLATION))).toBe(false);
    expect(isEntityUniquenessViolation(new DuplicateRepositoryError('r1'))).toBe(false);
    expect(isEntityUniquenessViolation(fakeDriverError('Neo.ClientError.Statement.TypeError', 'x'))).toBe(false);
    expect(isEntityUniquenessViolation(new ProviderError('down'))).toBe(false);
    expect(isEntityUniquenessViolation(null)).toBe(false);
  });
});

describe('isTransactionTimeout', () => {
  it('matches the GQL status 25N14', () => {
    expect(isTransactionTimeout({ gqlStatus: '25N14', code: 'Neo.ClientError.Transaction.Terminated' })).toBe(true);
  });

  it('matches the legacy TransactionTimedOut codes', () => {
    expect(isTransactionTimeout(fakeDriverError('Neo.ClientError.Transaction.TransactionTimedOut', 'x'))).toBe(true);
    expect(
      isTransactionTimeout(
        fakeDriverError('Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration', 'x'),
      ),
    ).toBe(true);
  });

  it('matches a timeout nested in the cause chain', () => {
    expect(isTransactionTimeout({ code: 'Wrapper', cause: { gqlStatus: '25N14' } })).toBe(true);
  });

  it('does not match other errors', () => {
    expect(isTransactionTimeout(fakeDriverError('Neo.TransientError.General.DatabaseUnavailable', 'x'))).toBe(false);
    expect(isTransactionTimeout(new Error('TransactionTimedOut in text only'))).toBe(false);
    expect(isTransactionTimeout(null)).toBe(false);
    expect(isTransactionTimeout(undefined)).toBe(false);
  });
});

describe('transaction memory limits', () => {
  it('pins the Neo4j 5 status codes for the per-transaction limit and the server-wide pool', () => {
    expect(TRANSACTION_MEMORY_LIMIT_CODE).toBe('Neo.TransientError.General.TransactionMemoryLimit');
    expect(MEMORY_POOL_EXHAUSTED_CODE).toBe('Neo.TransientError.General.MemoryPoolOutOfMemoryError');
  });

  it('classifies the two limits', () => {
    const txLimit = fakeDriverError(TRANSACTION_MEMORY_LIMIT_CODE, 'transaction memory limit exceeded');
    const pool = fakeDriverError(MEMORY_POOL_EXHAUSTED_CODE, 'memory pool limit exceeded');
    expect(isTransactionMemoryLimit(txLimit)).toBe(true);
    expect(isTransactionMemoryLimit(pool)).toBe(false);
    expect(isMemoryLimitFailure(txLimit)).toBe(true);
    expect(isMemoryLimitFailure(pool)).toBe(true);
    expect(isMemoryLimitFailure(fakeDriverError('ServiceUnavailable', 'x'))).toBe(false);
    expect(isMemoryLimitFailure(null)).toBe(false);
    // Neither is a row-shaped failure on its own.
    expect(isRowShapedFailure(txLimit)).toBe(false);
    expect(isRowShapedFailure(pool)).toBe(false);
  });
});

describe('isRetryableTransientFailure', () => {
  it('accepts a transient server failure', () => {
    expect(isRetryableTransientFailure(fakeDriverError('Neo.TransientError.Transaction.DeadlockDetected', 'deadlock'))).toBe(true);
    expect(isRetryableTransientFailure(fakeDriverError('Neo.TransientError.Transaction.LockClientStopped', 'stopped'))).toBe(true);
  });

  it('refuses the memory limits, which a re-run of the same statement hits again', () => {
    expect(isRetryableTransientFailure(fakeDriverError(TRANSACTION_MEMORY_LIMIT_CODE, 'limit'))).toBe(false);
    expect(isRetryableTransientFailure(fakeDriverError(MEMORY_POOL_EXHAUSTED_CODE, 'pool'))).toBe(false);
  });

  it('refuses client, database and connection failures', () => {
    expect(isRetryableTransientFailure(fakeDriverError('Neo.ClientError.Statement.EntityNotFound', 'gone'))).toBe(false);
    expect(isRetryableTransientFailure(fakeDriverError('Neo.DatabaseError.General.UnknownError', 'x'))).toBe(false);
    expect(isRetryableTransientFailure(fakeDriverError('ServiceUnavailable', 'x'))).toBe(false);
    expect(isRetryableTransientFailure(null)).toBe(false);
  });
});
