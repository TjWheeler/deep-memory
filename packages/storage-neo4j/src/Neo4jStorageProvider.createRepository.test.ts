// Unit tests for `createRepository` when the driver re-runs its statement.
//
// The driver re-runs a managed transaction after a retryable failure,
// including a commit whose acknowledgement was lost. These tests swap the
// provider's connection for a fake that keeps the repository marker in
// memory and, in the ack-lost mode, runs the create statement twice and
// answers with the second run's outcome — the shape the caller sees from
// `driver.executeQuery`.

import { describe, expect, it } from 'vitest';
import { DuplicateRepositoryError } from '@utaba/deep-memory';
import type { StorageRepositoryConfig } from '@utaba/deep-memory/types';
import type { Neo4jConnection } from './Neo4jConnection.js';
import { Neo4jStorageProvider } from './Neo4jStorageProvider.js';

const REPOSITORY_ID = 'repo-create-retry';
const CONSTRAINT_VIOLATION = 'Neo.ClientError.Schema.ConstraintValidationFailed';

function repositoryConfig(): StorageRepositoryConfig {
  return {
    repositoryId: REPOSITORY_ID,
    label: 'Create retry',
    governanceConfig: { mode: 'open' },
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'create-retry-test',
  };
}

interface Marker {
  writeAttempt: string | null;
}

/**
 * A provider whose connection is a fake over one in-memory repository
 * marker and its vocabulary count.
 *
 * - `ackLost`: the create statement commits, the acknowledgement is lost and
 *   the driver runs it again.
 * - `raceRefusal`: the create statement is refused by the repository
 *   uniqueness constraint, as when another transaction committed the marker
 *   after the statement's existence check; the value is what that other
 *   transaction stored, `'this-call'` meaning the call's own token.
 */
function providerOver(options: { marker?: Marker; ackLost?: boolean; raceRefusal?: Marker | 'this-call' }) {
  let marker: Marker | null = options.marker ?? null;
  let vocabularies = marker === null ? 0 : 1;
  const statements: Array<{ cypher: string; params: Record<string, unknown> }> = [];

  const runCreate = (params: Record<string, unknown>) => {
    const existing = marker;
    if (existing === null) {
      marker = { writeAttempt: params['writeAttempt'] as string };
      vocabularies += 1;
    }
    const values: Record<string, unknown> = {
      alreadyExists: existing !== null,
      liveWriteAttempt: existing?.writeAttempt ?? null,
      vocabularies: BigInt(existing === null ? 0 : vocabularies),
      leftoverEntities: false,
    };
    return { records: [{ get: (key: string) => values[key] }] };
  };

  const fake = {
    async executeQuery(cypher: string, params: Record<string, unknown>) {
      statements.push({ cypher, params });
      if (cypher.includes('CREATE (:_Repository')) {
        if (options.raceRefusal !== undefined) {
          marker =
            options.raceRefusal === 'this-call'
              ? { writeAttempt: params['writeAttempt'] as string }
              : options.raceRefusal;
          throw Object.assign(
            new Error(
              `Node(4) already exists with label \`_Repository\` and property \`repositoryId\` = '${REPOSITORY_ID}'`,
            ),
            { code: CONSTRAINT_VIOLATION },
          );
        }
        if (options.ackLost === true) runCreate(params);
        return runCreate(params);
      }
      if (cypher.includes('AS writeAttempt')) {
        const current = marker;
        return {
          records:
            current === null ? [] : [{ get: (key: string) => (key === 'writeAttempt' ? current.writeAttempt : undefined) }],
        };
      }
      throw new Error(`unexpected statement: ${cypher}`);
    },
  };

  const provider = new Neo4jStorageProvider({ uri: 'bolt://localhost:7687', username: 'neo4j', password: 'unused' });
  (provider as unknown as { connection: Neo4jConnection }).connection = fake as unknown as Neo4jConnection;
  return { provider, statements, marker: () => marker, vocabularies: () => vocabularies };
}

describe('createRepository under a driver re-run', () => {
  it('writes a fresh write token on the marker with every create', async () => {
    const first = providerOver({});
    const second = providerOver({});

    await first.provider.createRepository(repositoryConfig());
    await second.provider.createRepository(repositoryConfig());

    const firstCreate = first.statements[0]!;
    expect(firstCreate.cypher).toContain('_attempt: $writeAttempt');
    expect(firstCreate.params['writeAttempt']).toMatch(/^[0-9a-f-]{36}$/);
    expect(firstCreate.params['writeAttempt']).not.toBe(second.statements[0]!.params['writeAttempt']);
    expect(first.marker()).toEqual({ writeAttempt: firstCreate.params['writeAttempt'] });
  });

  it('reports success when the re-run finds the marker its own first run committed', async () => {
    const { provider, vocabularies, statements } = providerOver({ ackLost: true });

    await expect(provider.createRepository(repositoryConfig())).resolves.toMatchObject({
      repositoryId: REPOSITORY_ID,
      label: 'Create retry',
    });
    expect(vocabularies()).toBe(1);
    // The token comes back in the create statement's own result: no read-back.
    expect(statements).toHaveLength(1);
  });

  it('still throws DuplicateRepositoryError for a marker another call created', async () => {
    const { provider } = providerOver({ marker: { writeAttempt: 'another-call' } });

    await expect(provider.createRepository(repositoryConfig())).rejects.toBeInstanceOf(DuplicateRepositoryError);
  });

  it('still throws DuplicateRepositoryError for a marker written without a token', async () => {
    const { provider } = providerOver({ marker: { writeAttempt: null } });

    await expect(provider.createRepository(repositoryConfig())).rejects.toBeInstanceOf(DuplicateRepositoryError);
  });

  it('throws DuplicateRepositoryError when a uniqueness refusal names a marker another call stored', async () => {
    const { provider, statements } = providerOver({ raceRefusal: { writeAttempt: 'another-call' } });

    await expect(provider.createRepository(repositoryConfig())).rejects.toBeInstanceOf(DuplicateRepositoryError);
    expect(statements.some((s) => s.cypher.includes('AS writeAttempt'))).toBe(true);
  });

  it('reports success when a uniqueness refusal names the marker this call stored', async () => {
    const { provider } = providerOver({ raceRefusal: 'this-call' });

    await expect(provider.createRepository(repositoryConfig())).resolves.toMatchObject({
      repositoryId: REPOSITORY_ID,
    });
  });
});
