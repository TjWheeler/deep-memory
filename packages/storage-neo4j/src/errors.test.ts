import { describe, expect, it } from 'vitest';
import {
  DuplicateEntityError,
  DuplicateRelationshipError,
  ProviderError,
} from '@utaba/deep-memory';
import { mapDriverError } from './errors.js';

function fakeDriverError(code: string, message: string): unknown {
  // Mirror the surface used by `neo4j-driver`'s Neo4jError: an object with
  // string-typed `code` and `message` (probe P3 captured the exact shape).
  return { name: 'Neo4jError', code, message };
}

describe('mapDriverError', () => {
  it('maps constraint violation + entity context → DuplicateEntityError', () => {
    const err = fakeDriverError(
      'Neo.ClientError.Schema.ConstraintValidationFailed',
      "Node(0) already exists with label `_Entity` and properties `repositoryId` = 'r', `id` = 'e1'",
    );
    expect(() =>
      mapDriverError(err, { kind: 'entity', entityId: 'e1', operation: 'createEntity' }),
    ).toThrowError(DuplicateEntityError);
  });

  it('infers entity kind from the message when context.kind is omitted', () => {
    const err = fakeDriverError(
      'Neo.ClientError.Schema.ConstraintValidationFailed',
      "Node(0) already exists with label `_Entity` ...",
    );
    expect(() => mapDriverError(err, { entityId: 'e1' })).toThrowError(DuplicateEntityError);
  });

  it('maps constraint violation + relationship context → DuplicateRelationshipError', () => {
    const err = fakeDriverError(
      'Neo.ClientError.Schema.ConstraintValidationFailed',
      "Relationship(0) already exists with type `KNOWS` ...",
    );
    expect(() =>
      mapDriverError(err, { kind: 'relationship', relationshipId: 'r1' }),
    ).toThrowError(DuplicateRelationshipError);
  });

  it('falls back to ProviderError when no id is in scope', () => {
    const err = fakeDriverError(
      'Neo.ClientError.Schema.ConstraintValidationFailed',
      "Node(0) already exists with label `_Entity` ...",
    );
    expect(() => mapDriverError(err, { operation: 'createEntity' })).toThrowError(ProviderError);
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
  });

  it('handles errors that lack a code or message gracefully', () => {
    expect(() => mapDriverError({})).toThrowError(ProviderError);
    expect(() => mapDriverError(null)).toThrowError(ProviderError);
    expect(() => mapDriverError(undefined)).toThrowError(ProviderError);
  });
});
