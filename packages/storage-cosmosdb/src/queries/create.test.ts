// Unit tests for submitCreate: a store-side 409 (a second document with the
// same id in the partition) becomes the caller's typed duplicate error with
// the driver error as `cause`; every other failure reaches the caller as-is.

import { describe, it, expect } from 'vitest';
import {
  DuplicateEntityError,
  DuplicateRelationshipError,
  DuplicateRepositoryError,
  type DeepMemoryError,
} from '@utaba/deep-memory';
import type { CosmosDbConnection, GremlinResult } from '../CosmosDbConnection.js';
import { submitCreate } from './create.js';

/** Shape of the gremlin driver's ResponseError for a Cosmos-side failure. */
function responseError(status: number | string): Error {
  return Object.assign(new Error(`Server error (${status})`), {
    name: 'ResponseError',
    statusCode: 500,
    statusAttributes: { 'x-ms-status-code': status },
  });
}

function failingConnection(failure: Error): CosmosDbConnection {
  const fake = {
    async submit(): Promise<GremlinResult> {
      throw failure;
    },
  };
  return fake as unknown as CosmosDbConnection;
}

const duplicates: Array<{
  name: string;
  make: (cause: unknown) => DeepMemoryError;
  code: string;
}> = [
  { name: 'entity', make: (cause) => new DuplicateEntityError('e1', { cause }), code: 'ENTITY_ALREADY_EXISTS' },
  {
    name: 'relationship',
    make: (cause) => new DuplicateRelationshipError('r1', { cause }),
    code: 'RELATIONSHIP_ALREADY_EXISTS',
  },
  {
    name: 'repository',
    make: (cause) => new DuplicateRepositoryError('repo-1', { cause }),
    code: 'REPOSITORY_ALREADY_EXISTS',
  },
];

describe('submitCreate', () => {
  it('returns the submit result when the write succeeds', async () => {
    const conn = {
      async submit(): Promise<GremlinResult> {
        return { items: [{ id: 'created' }] };
      },
    } as unknown as CosmosDbConnection;

    await expect(submitCreate(conn, 'g.addV()', {}, (cause) => new DuplicateEntityError('e1', { cause }))).resolves.toEqual({
      items: [{ id: 'created' }],
    });
  });

  for (const { name, make, code } of duplicates) {
    it(`maps a 409 to the ${name} duplicate error with the driver error as cause`, async () => {
      const driverError = responseError(409);

      const create = submitCreate(failingConnection(driverError), 'g.addV()', {}, make);

      await expect(create).rejects.toMatchObject({ code, cause: driverError });
    });
  }

  it('reads a string status the same as a numeric one', async () => {
    const driverError = responseError('409');

    await expect(
      submitCreate(failingConnection(driverError), 'g.addV()', {}, (cause) => new DuplicateEntityError('e1', { cause })),
    ).rejects.toMatchObject({ code: 'ENTITY_ALREADY_EXISTS', cause: driverError });
  });

  for (const status of [400, 404, 412, 429, 503]) {
    it(`passes a ${status} through unchanged`, async () => {
      const driverError = responseError(status);

      await expect(
        submitCreate(failingConnection(driverError), 'g.addV()', {}, (cause) => new DuplicateEntityError('e1', { cause })),
      ).rejects.toBe(driverError);
    });
  }

  it('passes an error without a Cosmos status through unchanged', async () => {
    const driverError = new Error('socket hang up');

    await expect(
      submitCreate(failingConnection(driverError), 'g.addV()', {}, (cause) => new DuplicateEntityError('e1', { cause })),
    ).rejects.toBe(driverError);
  });
});
