import { describe, expect, it } from 'vitest';
import type { StoredRelationship } from '@utaba/deep-memory/types';
import { DeepMemoryError } from '@utaba/deep-memory';
import type { Neo4jConnection } from '../Neo4jConnection.js';
import {
  RELATIONSHIP_CREATE_OUTCOME,
  buildCreateMintedRelationshipQuery,
  buildCreateRelationshipQuery,
  createRelationship,
} from './relationship.js';
import { LOCK_REPOSITORY_MARKER_OPTIONAL } from './repositoryLock.js';

const RID = 'repo-relationship';

function relationship(overrides: Partial<StoredRelationship> = {}): StoredRelationship {
  const now = new Date().toISOString();
  return {
    id: 'r1',
    relationshipType: 'KNOWS',
    sourceEntityId: 'source-entity',
    targetEntityId: 'target-entity',
    properties: {},
    bidirectional: false,
    provenance: {
      createdBy: 'relationship-test',
      createdByType: 'agent',
      createdAt: now,
      modifiedBy: 'relationship-test',
      modifiedByType: 'agent',
      modifiedAt: now,
    },
    ...overrides,
  };
}

/** Connection fake whose create statement reports `outcome` (or no row). */
function connectionReporting(outcome: string | undefined): {
  conn: Neo4jConnection;
  calls: Array<{ cypher: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ cypher: string; params: Record<string, unknown> }> = [];
  const fake = {
    async executeQuery(cypher: string, params: Record<string, unknown>) {
      calls.push({ cypher, params });
      if (outcome === undefined) return { records: [] };
      return { records: [{ get: (key: string) => (key === 'outcome' ? outcome : undefined) }] };
    },
  };
  return { conn: fake as unknown as Neo4jConnection, calls };
}

describe('createRelationship outcome mapping', () => {
  it('returns the relationship when the statement created it', async () => {
    const rel = relationship();
    const { conn, calls } = connectionReporting(RELATIONSHIP_CREATE_OUTCOME.created);

    await expect(createRelationship(conn, RID, rel, false)).resolves.toBe(rel);
    expect(calls).toHaveLength(1);
  });

  it('maps a missing repository to RepositoryNotFoundError', async () => {
    const { conn } = connectionReporting(RELATIONSHIP_CREATE_OUTCOME.repositoryMissing);

    await expect(createRelationship(conn, RID, relationship(), false)).rejects.toMatchObject({
      name: 'RepositoryNotFoundError',
      code: 'REPOSITORY_NOT_FOUND',
      repositoryId: RID,
    });
  });

  it('maps a missing source to EntityNotFoundError carrying the source id', async () => {
    const { conn } = connectionReporting(RELATIONSHIP_CREATE_OUTCOME.sourceMissing);

    await expect(createRelationship(conn, RID, relationship(), false)).rejects.toMatchObject({
      name: 'EntityNotFoundError',
      code: 'ENTITY_NOT_FOUND',
      id: 'source-entity',
    });
  });

  it('maps a missing target to EntityNotFoundError carrying the target id', async () => {
    const { conn } = connectionReporting(RELATIONSHIP_CREATE_OUTCOME.targetMissing);

    await expect(createRelationship(conn, RID, relationship(), false)).rejects.toMatchObject({
      name: 'EntityNotFoundError',
      code: 'ENTITY_NOT_FOUND',
      id: 'target-entity',
    });
  });

  it('maps an id already in use to DuplicateRelationshipError', async () => {
    const { conn } = connectionReporting(RELATIONSHIP_CREATE_OUTCOME.idExists);

    await expect(createRelationship(conn, RID, relationship(), false)).rejects.toMatchObject({
      name: 'DuplicateRelationshipError',
      code: 'RELATIONSHIP_ALREADY_EXISTS',
      relationshipId: 'r1',
    });
  });

  it('reports a statement that returns no outcome as ProviderError', async () => {
    const { conn } = connectionReporting(undefined);

    await expect(createRelationship(conn, RID, relationship(), false)).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'PROVIDER_ERROR',
    });
  });

  it('reports an unrecognised outcome as ProviderError', async () => {
    const { conn } = connectionReporting('something-else');

    await expect(createRelationship(conn, RID, relationship(), false)).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'PROVIDER_ERROR',
    });
  });

  it('refuses an unsafe relationship type before any round-trip', async () => {
    const { conn, calls } = connectionReporting(RELATIONSHIP_CREATE_OUTCOME.created);

    await expect(
      createRelationship(conn, RID, relationship({ relationshipType: 'KNOWS]->() DETACH DELETE (x' }), false),
    ).rejects.toMatchObject({ name: 'ProviderError' });
    expect(calls).toHaveLength(0);
  });

  it('passes the relationship id and endpoints as parameters, not in the Cypher text', async () => {
    const rel = relationship({ id: 'rel-id-param', sourceEntityId: 'src-param', targetEntityId: 'tgt-param' });
    const { conn, calls } = connectionReporting(RELATIONSHIP_CREATE_OUTCOME.created);

    await createRelationship(conn, RID, rel, false);

    const [call] = calls;
    expect(call!.params).toMatchObject({ id: 'rel-id-param', sourceEntityId: 'src-param', targetEntityId: 'tgt-param' });
    expect(call!.cypher).not.toContain('rel-id-param');
    expect(call!.cypher).not.toContain('src-param');
  });
});

/** A driver error carrying the status code a server raises for a deleted node. */
function deletedEntityError(): Error & { code: string } {
  return Object.assign(new Error('Node with id 42 has been deleted in this transaction'), {
    code: 'Neo.ClientError.Statement.EntityNotFound',
  });
}

/**
 * Connection fake whose create statement fails with `error`, and whose
 * follow-up precondition read reports `exists` (or no row when undefined).
 */
function connectionFailingWith(
  error: unknown,
  exists?: { repositoryExists: boolean; sourceExists: boolean; targetExists: boolean },
): { conn: Neo4jConnection; calls: Array<{ cypher: string; params: Record<string, unknown> }> } {
  const calls: Array<{ cypher: string; params: Record<string, unknown> }> = [];
  const fake = {
    async executeQuery(cypher: string, params: Record<string, unknown>) {
      calls.push({ cypher, params });
      if (calls.length === 1) throw error;
      if (exists === undefined) return { records: [] };
      const values: Record<string, boolean> = exists;
      return { records: [{ get: (key: string) => values[key] }] };
    },
  };
  return { conn: fake as unknown as Neo4jConnection, calls };
}

describe('createRelationship on a node deleted while the statement waited', () => {
  const all = { repositoryExists: true, sourceExists: true, targetExists: true };

  it('reads the preconditions once and reports a deleted repository first', async () => {
    const { conn, calls } = connectionFailingWith(deletedEntityError(), {
      repositoryExists: false,
      sourceExists: false,
      targetExists: false,
    });

    await expect(createRelationship(conn, RID, relationship(), false)).rejects.toMatchObject({
      name: 'RepositoryNotFoundError',
      repositoryId: RID,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.cypher).toContain('$rid');
    expect(calls[1]!.params).toEqual({ sourceEntityId: 'source-entity', targetEntityId: 'target-entity' });
  });

  it('reports a deleted source ahead of a deleted target', async () => {
    const { conn } = connectionFailingWith(deletedEntityError(), {
      ...all,
      sourceExists: false,
      targetExists: false,
    });

    await expect(createRelationship(conn, RID, relationship(), false)).rejects.toMatchObject({
      name: 'EntityNotFoundError',
      id: 'source-entity',
    });
  });

  it('reports a deleted target', async () => {
    const { conn } = connectionFailingWith(deletedEntityError(), { ...all, targetExists: false });

    await expect(createRelationship(conn, RID, relationship(), false)).rejects.toMatchObject({
      name: 'EntityNotFoundError',
      id: 'target-entity',
    });
  });

  it('rethrows the original error, mapped, when everything still exists', async () => {
    const original = deletedEntityError();
    const { conn } = connectionFailingWith(original, all);

    const thrown: unknown = await createRelationship(conn, RID, relationship(), false).catch((err: unknown) => err);
    expect(thrown).toMatchObject({ name: 'ProviderError', code: 'PROVIDER_ERROR' });
    expect((thrown as Error).cause).toBe(original);
  });

  it('reports a precondition read with no row as ProviderError', async () => {
    const { conn } = connectionFailingWith(deletedEntityError());

    await expect(createRelationship(conn, RID, relationship(), false)).rejects.toMatchObject({
      name: 'ProviderError',
    });
  });

  it('maps a driver failure of the precondition read itself to a typed error', async () => {
    const readFailure = Object.assign(new Error('connection reset'), {
      code: 'ServiceUnavailable',
    });
    const calls: string[] = [];
    const fake = {
      async executeQuery(cypher: string) {
        calls.push(cypher);
        throw calls.length === 1 ? deletedEntityError() : readFailure;
      },
    };

    const thrown: unknown = await createRelationship(fake as unknown as Neo4jConnection, RID, relationship(), false).catch(
      (err: unknown) => err,
    );
    expect(calls).toHaveLength(2);
    expect(thrown).toBeInstanceOf(DeepMemoryError);
    expect(thrown).toMatchObject({ name: 'ProviderError', code: 'PROVIDER_ERROR' });
    expect((thrown as Error).message).toContain('createRelationship');
    expect((thrown as Error).cause).toBe(readFailure);
  });

  it('maps any other driver error without a follow-up read', async () => {
    const other = Object.assign(new Error('boom'), { code: 'Neo.DatabaseError.General.UnknownError' });
    const { conn, calls } = connectionFailingWith(other, all);

    await expect(createRelationship(conn, RID, relationship(), false)).rejects.toMatchObject({
      name: 'ProviderError',
    });
    expect(calls).toHaveLength(1);
  });
});

describe('buildCreateRelationshipQuery', () => {
  const cypher = buildCreateRelationshipQuery('KNOWS');

  it('locks the repository marker before any other clause', () => {
    expect(cypher.trimStart().startsWith(LOCK_REPOSITORY_MARKER_OPTIONAL.trim())).toBe(true);
  });

  it('checks the id across every relationship type in the repository, after the lock', () => {
    const idCheck = `EXISTS {
    MATCH (e:_Entity {repositoryId: $rid})-[{repositoryId: $rid, id: $id}]->()
    WHERE e.id IS NOT NULL
  } AS idTaken`;
    expect(cypher).toContain(idCheck);
    expect(cypher.indexOf(idCheck)).toBeGreaterThan(cypher.indexOf('REMOVE repo._lock'));
  });

  it('creates with CREATE, never MERGE', () => {
    expect(cypher).toContain('CREATE (s)-[r:KNOWS {');
    expect(cypher).not.toContain('MERGE');
  });
});

describe('createRelationship under a driver re-run', () => {
  /**
   * A connection fake over an in-memory set of edges keyed by id, each with
   * its source entity and the write token it was created with. The create statement reports
   * `id-exists` for a stored id, as the real statement does. With `ackLost`,
   * the driver commits the first run, loses the acknowledgement and runs the
   * statement again, answering with the second run's outcome.
   */
  interface StoredEdge {
    source: string;
    token: string | null;
  }

  function edgeStore(options: { seed?: Array<[string, StoredEdge]>; ackLost: boolean }) {
    const edges = new Map<string, StoredEdge[]>();
    for (const [id, edge] of options.seed ?? []) edges.set(id, [...(edges.get(id) ?? []), edge]);
    const statements: Array<{ cypher: string; params: Record<string, unknown> }> = [];

    const runCreate = (params: Record<string, unknown>) => {
      const id = params['id'] as string;
      let outcome: string = RELATIONSHIP_CREATE_OUTCOME.idExists;
      if (!edges.has(id)) {
        edges.set(id, [{ source: params['sourceEntityId'] as string, token: params['writeAttempt'] as string }]);
        outcome = RELATIONSHIP_CREATE_OUTCOME.created;
      }
      return { records: [{ get: (key: string) => (key === 'outcome' ? outcome : undefined) }] };
    };

    const fake = {
      async executeQuery(cypher: string, params: Record<string, unknown>) {
        statements.push({ cypher, params });
        if (cypher.includes('RETURN outcome')) {
          if (options.ackLost) runCreate(params);
          return runCreate(params);
        }
        if (cypher.includes('AS writeAttempt')) {
          const matching = (edges.get(params['id'] as string) ?? []).filter(
            (edge) => edge.source === params['sourceEntityId'],
          );
          return {
            records: matching.map((edge) => ({ get: (key: string) => (key === 'writeAttempt' ? edge.token : undefined) })),
          };
        }
        throw new Error(`unexpected statement: ${cypher}`);
      },
    };
    return { conn: fake as unknown as Neo4jConnection, edges, statements };
  }

  it('writes a fresh write token with every create', async () => {
    const { conn, edges, statements } = edgeStore({ ackLost: false });

    await createRelationship(conn, RID, relationship(), false);
    await createRelationship(conn, RID, relationship({ id: 'r2' }), false);

    const [first, second] = statements;
    expect(first!.cypher).toContain('_attempt: $writeAttempt');
    expect(first!.params['writeAttempt']).toMatch(/^[0-9a-f-]{36}$/);
    expect(first!.params['writeAttempt']).not.toBe(second!.params['writeAttempt']);
    expect(edges.get('r1')).toEqual([{ source: 'source-entity', token: first!.params['writeAttempt'] }]);
  });

  it('reports success, with one edge stored, when the re-run finds its own committed edge', async () => {
    const rel = relationship();
    const { conn, edges } = edgeStore({ ackLost: true });

    await expect(createRelationship(conn, RID, rel, false)).resolves.toBe(rel);
    expect(edges.get('r1')).toHaveLength(1);
  });

  it('reads the token back by id from the source entity under the repository scope', async () => {
    const { conn, statements } = edgeStore({ ackLost: true });

    await createRelationship(conn, RID, relationship({ id: 'rel-param', sourceEntityId: 'src-param' }), false);

    const readBack = statements.find((s) => s.cypher.includes('AS writeAttempt'));
    expect(readBack!.params).toEqual({ id: 'rel-param', sourceEntityId: 'src-param' });
    expect(readBack!.cypher).toContain('(s:_Entity {repositoryId: $rid, id: $sourceEntityId})');
    expect(readBack!.cypher).toContain('[r {repositoryId: $rid, id: $id}]');
    expect(readBack!.cypher).not.toContain('rel-param');
    expect(readBack!.cypher).not.toContain('src-param');
  });

  it('still throws DuplicateRelationshipError when the id is held by an edge from another source', async () => {
    const { conn } = edgeStore({ ackLost: false, seed: [['r1', { source: 'other-source', token: 'another-call' }]] });

    await expect(createRelationship(conn, RID, relationship(), false)).rejects.toMatchObject({
      name: 'DuplicateRelationshipError',
      relationshipId: 'r1',
    });
  });

  it('reports a failed token read-back as ProviderError rather than guessing', async () => {
    const readFailure = Object.assign(new Error('connection reset'), { code: 'ServiceUnavailable' });
    const fake = {
      async executeQuery(cypher: string) {
        if (cypher.includes('RETURN outcome')) {
          return {
            records: [
              { get: (key: string) => (key === 'outcome' ? RELATIONSHIP_CREATE_OUTCOME.idExists : undefined) },
            ],
          };
        }
        throw readFailure;
      },
    };

    await expect(createRelationship(fake as unknown as Neo4jConnection, RID, relationship(), false)).rejects.toMatchObject({
      name: 'ProviderError',
      cause: readFailure,
    });
  });

  it('still throws DuplicateRelationshipError for an id another call created', async () => {
    const { conn } = edgeStore({ ackLost: false, seed: [['r1', { source: 'source-entity', token: 'another-call' }]] });

    await expect(createRelationship(conn, RID, relationship(), false)).rejects.toMatchObject({
      name: 'DuplicateRelationshipError',
      relationshipId: 'r1',
    });
  });

  it('still throws DuplicateRelationshipError for an id an import wrote without a token', async () => {
    const { conn } = edgeStore({ ackLost: false, seed: [['r1', { source: 'source-entity', token: null }]] });

    await expect(createRelationship(conn, RID, relationship(), false)).rejects.toMatchObject({
      name: 'DuplicateRelationshipError',
    });
  });
});

describe('buildCreateMintedRelationshipQuery', () => {
  const cypher = buildCreateMintedRelationshipQuery('KNOWS');

  it('locks the repository marker before any other clause', () => {
    expect(cypher.trimStart().startsWith(LOCK_REPOSITORY_MARKER_OPTIONAL.trim())).toBe(true);
  });

  it('does not look for the id among the repository\'s edges', () => {
    expect(cypher).not.toContain('EXISTS');
    expect(cypher).not.toContain('idTaken');
    expect(cypher).not.toContain(RELATIONSHIP_CREATE_OUTCOME.idExists);
    expect(cypher).not.toContain('(e:_Entity');
  });

  it('keeps the repository, source, target precedence', () => {
    const order = [
      RELATIONSHIP_CREATE_OUTCOME.repositoryMissing,
      RELATIONSHIP_CREATE_OUTCOME.sourceMissing,
      RELATIONSHIP_CREATE_OUTCOME.targetMissing,
      RELATIONSHIP_CREATE_OUTCOME.created,
    ].map((outcome) => cypher.indexOf(`'${outcome}'`));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('MERGEs between the bound endpoints on the id and the write token', () => {
    expect(cypher).toContain(
      'MERGE (s)-[r:KNOWS {repositoryId: $rid, id: $id, _attempt: $writeAttempt}]->(t)\n  ON CREATE SET',
    );
    expect(cypher).toContain('OPTIONAL MATCH (s:_Entity {repositoryId: $rid, id: $sourceEntityId})');
    expect(cypher).toContain('OPTIONAL MATCH (t:_Entity {repositoryId: $rid, id: $targetEntityId})');
    expect(cypher).not.toMatch(/\bCREATE \(/);
  });

  it('refuses an unsafe relationship type', () => {
    expect(() => buildCreateMintedRelationshipQuery('KNOWS]->() DETACH DELETE (x')).toThrow();
  });
});

describe('createRelationship with a minted id', () => {
  it('runs the statement without the id check and answers created', async () => {
    const rel = relationship();
    const { conn, calls } = connectionReporting(RELATIONSHIP_CREATE_OUTCOME.created);

    await expect(createRelationship(conn, RID, rel, true)).resolves.toBe(rel);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cypher).toBe(buildCreateMintedRelationshipQuery('KNOWS'));
    expect(calls[0]!.params).toMatchObject({ id: 'r1', sourceEntityId: 'source-entity', targetEntityId: 'target-entity' });
    expect(calls[0]!.params['writeAttempt']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('maps the repository and endpoint outcomes as the checked path does', async () => {
    for (const [outcome, expected] of [
      [RELATIONSHIP_CREATE_OUTCOME.repositoryMissing, { name: 'RepositoryNotFoundError', repositoryId: RID }],
      [RELATIONSHIP_CREATE_OUTCOME.sourceMissing, { name: 'EntityNotFoundError', id: 'source-entity' }],
      [RELATIONSHIP_CREATE_OUTCOME.targetMissing, { name: 'EntityNotFoundError', id: 'target-entity' }],
    ] as const) {
      const { conn } = connectionReporting(outcome);
      await expect(createRelationship(conn, RID, relationship(), true)).rejects.toMatchObject(expected);
    }
  });

  it('a driver re-run of a committed create answers success without a read-back', async () => {
    const rel = relationship();
    const statements: string[] = [];
    const fake = {
      async executeQuery(cypher: string) {
        statements.push(cypher);
        // Every run of the MERGE reports created: the re-run matched the edge
        // its first run wrote.
        return { records: [{ get: (key: string) => (key === 'outcome' ? RELATIONSHIP_CREATE_OUTCOME.created : undefined) }] };
      },
    };

    await expect(createRelationship(fake as unknown as Neo4jConnection, RID, rel, true)).resolves.toBe(rel);
    expect(statements.some((cypher) => cypher.includes('AS writeAttempt'))).toBe(false);
  });
});
