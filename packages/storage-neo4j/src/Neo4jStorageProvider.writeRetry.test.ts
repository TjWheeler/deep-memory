// Writes re-run by the driver after a commit whose acknowledgement was lost (live).
//
// The driver re-runs a managed transaction after a retryable failure,
// including a failure on commit, so a write can run a second time against
// the state its own first run committed. Dropping a connection at exactly
// that moment is impractical in a test, so the provider here talks to a
// connection that runs every create statement (single and bulk insert)
// twice, and every managed write as two attempts, each committed. The second run is
// exactly what the driver's retry would send, against real constraints and
// real data.
//
// Set NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD to run. Skipped otherwise so
// CI builds without a live Neo4j stay green.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DuplicateEntityError,
  DuplicateRelationshipError,
  DuplicateRepositoryError,
  EntityNotFoundError,
  InvalidInputError,
  RepositoryNotFoundError,
  SlugConflictError,
  TraversalValidationError,
} from '@utaba/deep-memory';
import type { BulkImportOptions, StoredEntity, StoredRelationship } from '@utaba/deep-memory/types';
import { Neo4jConnection, type CypherParams, type ExecuteQueryOptions, type ScopedTransaction } from './Neo4jConnection.js';
import { Neo4jStorageProvider } from './Neo4jStorageProvider.js';

const NEO4J_URI = process.env['NEO4J_URI'];
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? '';
const NEO4J_DATABASE = process.env['NEO4J_DATABASE'] ?? 'neo4j';

// The single creates, the insert import's entity template (`CREATE (n:_Entity)`)
// and the insert import's relationship template.
const CREATE_STATEMENT_MARKERS = [
  'CREATE (n:_Entity',
  'CREATE (:_Repository',
  'RETURN outcome',
  '_attempt: $writeAttempt}]->(t)',
];

const INSERT: BulkImportOptions = { skipExistenceCheck: true };

/**
 * A connection that commits every create statement once and then sends it
 * again, answering with the second run, and runs every managed write as a
 * committed attempt 1 followed by attempt 2.
 */
class RerunningConnection extends Neo4jConnection {
  public override async executeQuery<T extends Record<string, unknown>>(
    cypher: string,
    params: CypherParams,
    options: ExecuteQueryOptions,
  ) {
    if (CREATE_STATEMENT_MARKERS.some((marker) => cypher.includes(marker))) {
      await super.executeQuery<T>(cypher, params, options);
    }
    return super.executeQuery<T>(cypher, params, options);
  }

  public override async executeWrite<T>(
    repositoryId: string,
    txFn: (tx: ScopedTransaction, attempt: number) => Promise<T>,
  ): Promise<T> {
    await super.executeWrite(repositoryId, (tx) => txFn(tx, 1));
    return super.executeWrite(repositoryId, (tx) => txFn(tx, 2));
  }
}

function provenance(): StoredEntity['provenance'] {
  const now = new Date().toISOString();
  return {
    createdBy: 'write-retry-test',
    createdByType: 'agent',
    createdAt: now,
    modifiedBy: 'write-retry-test',
    modifiedByType: 'agent',
    modifiedAt: now,
  };
}

function makeEntity(id: string, slug = `person:${id}`): StoredEntity {
  return { id, slug, entityType: 'Person', label: id, properties: {}, provenance: provenance() };
}

function makeRelationship(id: string, sourceEntityId: string, targetEntityId: string): StoredRelationship {
  return {
    id,
    relationshipType: 'KNOWS',
    sourceEntityId,
    targetEntityId,
    properties: {},
    bidirectional: false,
    provenance: provenance(),
  };
}

if (NEO4J_URI) {
  describe('Neo4jStorageProvider — writes re-run after a lost commit acknowledgement (live)', () => {
    const config = { uri: NEO4J_URI, username: NEO4J_USER, password: NEO4J_PASSWORD, database: NEO4J_DATABASE };
    let provider: Neo4jStorageProvider;
    let rerunning: Neo4jStorageProvider;
    const repositories: string[] = [];

    beforeAll(async () => {
      provider = new Neo4jStorageProvider(config);
      await provider.initialize();
      await provider.ensureSchema();
      rerunning = new Neo4jStorageProvider(config);
      await rerunning.initialize();
      const swapped = rerunning as unknown as { connection: Neo4jConnection };
      await swapped.connection.close();
      swapped.connection = new RerunningConnection(config);
    });

    afterAll(async () => {
      for (const repositoryId of repositories) {
        try {
          await provider.deleteRepository(repositoryId);
        } catch (err) {
          if (!(err instanceof RepositoryNotFoundError)) throw err;
        }
      }
      await rerunning.dispose();
      await provider.dispose();
    }, 60_000);

    async function newRepository(via: Neo4jStorageProvider = provider): Promise<string> {
      const repositoryId = randomUUID();
      repositories.push(repositoryId);
      await via.createRepository({
        repositoryId,
        label: 'write retry',
        governanceConfig: { mode: 'open' },
        createdAt: new Date().toISOString(),
        createdBy: 'write-retry-test',
      });
      return repositoryId;
    }

    async function count(repositoryId: string, cypher: string, params: Record<string, unknown> = {}): Promise<number> {
      const rows = (await provider.executeNativeQuery(repositoryId, cypher, { repositoryId, ...params })) as Array<{
        n: bigint | number;
      }>;
      return Number(rows[0]?.n ?? -1);
    }

    it('createRepository answers success and leaves one marker and one vocabulary', async () => {
      const repositoryId = await newRepository(rerunning);

      expect(await provider.getRepository(repositoryId)).toMatchObject({ repositoryId, label: 'write retry' });
      expect(await count(repositoryId, 'MATCH (r:_Repository {repositoryId: $repositoryId}) RETURN count(r) AS n')).toBe(1);
      expect(await count(repositoryId, 'MATCH (v:_Vocabulary {repositoryId: $repositoryId}) RETURN count(v) AS n')).toBe(1);
    });

    it('createEntity answers success and stores the entity once, with its token hidden from reads', async () => {
      const repositoryId = await newRepository();
      const entity = makeEntity(randomUUID());

      await expect(rerunning.createEntity(repositoryId, entity)).resolves.toEqual(entity);

      expect(
        await count(repositoryId, 'MATCH (n:_Entity {repositoryId: $repositoryId, id: $id}) RETURN count(n) AS n', {
          id: entity.id,
        }),
      ).toBe(1);
      const stored = await provider.getEntity(repositoryId, entity.id);
      expect(stored).not.toBeNull();
      expect(JSON.stringify(stored)).not.toContain('_attempt');
    });

    it('createRelationship answers success and stores the edge once', async () => {
      const repositoryId = await newRepository();
      const [a, b] = [makeEntity(randomUUID()), makeEntity(randomUUID())];
      await provider.createEntity(repositoryId, a);
      await provider.createEntity(repositoryId, b);
      const relationship = makeRelationship(randomUUID(), a.id, b.id);

      await expect(rerunning.createRelationship(repositoryId, relationship)).resolves.toEqual(relationship);

      expect(
        await count(repositoryId, 'MATCH ()-[r {repositoryId: $repositoryId, id: $id}]->() RETURN count(r) AS n', {
          id: relationship.id,
        }),
      ).toBe(1);
      expect(JSON.stringify(await provider.getRelationship(repositoryId, relationship.id))).not.toContain('_attempt');
    });

    it('createRelationship with a minted id answers success and stores the edge once', async () => {
      const repositoryId = await newRepository();
      const [a, b] = [makeEntity(randomUUID()), makeEntity(randomUUID())];
      await provider.createEntity(repositoryId, a);
      await provider.createEntity(repositoryId, b);
      const relationship = makeRelationship(randomUUID(), a.id, b.id);

      await expect(rerunning.createRelationship(repositoryId, relationship, { idMinted: true })).resolves.toEqual(
        relationship,
      );

      expect(
        await count(repositoryId, 'MATCH ()-[r {repositoryId: $repositoryId, id: $id}]->() RETURN count(r) AS n', {
          id: relationship.id,
        }),
      ).toBe(1);
      const stored = await provider.getRelationship(repositoryId, relationship.id);
      expect(stored).toMatchObject({
        id: relationship.id,
        relationshipType: relationship.relationshipType,
        sourceEntityId: a.id,
        targetEntityId: b.id,
        provenance: { createdBy: 'write-retry-test' },
      });
      expect(JSON.stringify(stored)).not.toContain('_attempt');
    });

    it('createRelationship with a minted id still reports a missing endpoint or repository when re-run', async () => {
      const repositoryId = await newRepository();
      const a = makeEntity(randomUUID());
      await provider.createEntity(repositoryId, a);

      await expect(
        rerunning.createRelationship(repositoryId, makeRelationship(randomUUID(), a.id, 'missing-target'), {
          idMinted: true,
        }),
      ).rejects.toBeInstanceOf(EntityNotFoundError);
      await provider.deleteRepository(repositoryId);
      await expect(
        rerunning.createRelationship(repositoryId, makeRelationship(randomUUID(), a.id, a.id), { idMinted: true }),
      ).rejects.toBeInstanceOf(RepositoryNotFoundError);
    });

    it('deleteEntities and deleteRelationships report what the first attempt deleted as deleted', async () => {
      const repositoryId = await newRepository();
      const [a, b, c] = [makeEntity(randomUUID()), makeEntity(randomUUID()), makeEntity(randomUUID())];
      for (const entity of [a, b, c]) await provider.createEntity(repositoryId, entity);
      const relationship = makeRelationship(randomUUID(), a.id, b.id);
      await provider.createRelationship(repositoryId, relationship);

      const relationships = await rerunning.deleteRelationships(repositoryId, [relationship.id, 'missing-relationship']);
      expect(relationships).toEqual({ deleted: [relationship.id], notFound: ['missing-relationship'] });

      const entities = await rerunning.deleteEntities(repositoryId, [a.id, b.id, 'missing-entity']);
      expect(entities.deleted.sort()).toEqual([a.id, b.id].sort());
      expect(entities.notFound).toEqual(['missing-entity']);
      expect(await provider.getEntity(repositoryId, c.id)).not.toBeNull();
    });

    it('deleteEntity answers success for the entity its first attempt deleted', async () => {
      const repositoryId = await newRepository();
      const [a, b] = [makeEntity(randomUUID()), makeEntity(randomUUID())];
      for (const entity of [a, b]) await provider.createEntity(repositoryId, entity);
      await provider.createRelationship(repositoryId, makeRelationship(randomUUID(), a.id, b.id));

      await expect(rerunning.deleteEntity(repositoryId, a.id)).resolves.toBeUndefined();

      expect(await provider.getEntity(repositoryId, a.id)).toBeNull();
      expect(await provider.getEntity(repositoryId, b.id)).not.toBeNull();
      expect(await count(repositoryId, 'MATCH ()-[r {repositoryId: $repositoryId}]->() RETURN count(r) AS n')).toBe(0);
      await expect(rerunning.deleteEntity(repositoryId, 'missing-entity')).rejects.toBeInstanceOf(EntityNotFoundError);
    });

    it('an insert import reports every row of re-run chunks imported, and stores each record once', async () => {
      const repositoryId = await newRepository();
      const entities = [makeEntity(randomUUID()), makeEntity(randomUUID()), makeEntity(randomUUID())];
      const [a, b, c] = entities as [StoredEntity, StoredEntity, StoredEntity];
      const relationships = [makeRelationship(randomUUID(), a.id, b.id), makeRelationship(randomUUID(), b.id, c.id)];

      const result = await rerunning.importBulk(repositoryId, [{ entities, relationships }], INSERT);

      expect(result).toEqual({ entitiesImported: 3, relationshipsImported: 2, errors: [] });
      expect(await count(repositoryId, 'MATCH (n:_Entity {repositoryId: $repositoryId}) RETURN count(n) AS n')).toBe(3);
      for (const relationship of relationships) {
        expect(
          await count(repositoryId, 'MATCH ()-[r {repositoryId: $repositoryId, id: $id}]->() RETURN count(r) AS n', {
            id: relationship.id,
          }),
        ).toBe(1);
      }
      expect(JSON.stringify(await provider.getEntity(repositoryId, a.id))).not.toContain('_attempt');
      expect(JSON.stringify(await provider.getRelationship(repositoryId, relationships[0]!.id))).not.toContain('_attempt');
    });

    it('an insert import still reports genuine duplicates and a repeated id once when its rows are re-run', async () => {
      const repositoryId = await newRepository();
      const existing = makeEntity(randomUUID());
      await provider.createEntity(repositoryId, existing);
      const fresh = makeEntity(randomUUID());
      const repeated = makeEntity(randomUUID());

      const result = await rerunning.importBulk(
        repositoryId,
        [
          {
            entities: [
              makeEntity(existing.id, `person:${randomUUID()}`),
              fresh,
              repeated,
              makeEntity(repeated.id, `person:${randomUUID()}`),
            ],
          },
        ],
        INSERT,
      );

      expect(result.entitiesImported).toBe(2);
      expect(result.errors).toHaveLength(2);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ item: `entity:${existing.id}`, code: 'ENTITY_ALREADY_EXISTS' }),
          expect.objectContaining({ item: `entity:${repeated.id}`, code: 'ENTITY_ALREADY_EXISTS' }),
        ]),
      );
      expect(await count(repositoryId, 'MATCH (n:_Entity {repositoryId: $repositoryId}) RETURN count(n) AS n')).toBe(3);
      expect((await provider.getEntity(repositoryId, repeated.id))?.slug).toBe(repeated.slug);
    });

    it('still refuses genuine duplicates made by another call', async () => {
      const repositoryId = await newRepository();
      const [a, b] = [makeEntity(randomUUID()), makeEntity(randomUUID())];
      await provider.createEntity(repositoryId, a);
      await provider.createEntity(repositoryId, b);
      const relationship = makeRelationship(randomUUID(), a.id, b.id);
      await provider.createRelationship(repositoryId, relationship);

      await expect(
        rerunning.createRepository({
          repositoryId,
          label: 'again',
          governanceConfig: { mode: 'open' },
          createdAt: new Date().toISOString(),
          createdBy: 'write-retry-test',
        }),
      ).rejects.toBeInstanceOf(DuplicateRepositoryError);
      await expect(rerunning.createEntity(repositoryId, makeEntity(a.id, `person:${randomUUID()}`))).rejects.toBeInstanceOf(
        DuplicateEntityError,
      );
      await expect(rerunning.createEntity(repositoryId, makeEntity(randomUUID(), a.slug))).rejects.toBeInstanceOf(
        SlugConflictError,
      );
      await expect(
        rerunning.createRelationship(repositoryId, makeRelationship(relationship.id, b.id, a.id)),
      ).rejects.toBeInstanceOf(DuplicateRelationshipError);
    });

    it('keeps the token out of traversal projections and entity filters', async () => {
      const repositoryId = await newRepository();
      const entity = makeEntity(randomUUID());
      await provider.createEntity(repositoryId, entity);

      await expect(
        provider.traverse(repositoryId, {
          start: { entityId: entity.id },
          returnMode: 'terminal',
          projection: { properties: ['_attempt'] },
        }),
      ).rejects.toBeInstanceOf(TraversalValidationError);
      await expect(provider.findEntities(repositoryId, { properties: { _attempt: 'x' }, limit: 10, offset: 0 })).rejects.toBeInstanceOf(
        InvalidInputError,
      );
    });
  });
} else {
  describe('Neo4jStorageProvider — writes re-run after a lost commit acknowledgement', () => {
    it('skipped — set NEO4J_URI to run', () => {
      expect(true).toBe(true);
    });
  });
}
