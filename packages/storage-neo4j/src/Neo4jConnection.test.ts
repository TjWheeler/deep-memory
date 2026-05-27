import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '@utaba/deep-memory';
import { Neo4jConnection } from './Neo4jConnection.js';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

// ─── 1. executeQuery — Cypher missing $rid token throws ProviderError ────

describe('Neo4jConnection.executeQuery isolation enforcement', () => {
  let connection: Neo4jConnection;

  beforeEach(() => {
    connection = new Neo4jConnection({
      uri: 'bolt://localhost:7687',
      username: 'neo4j',
      password: 'unused-by-this-test',
    });
  });

  afterEach(async () => {
    await connection.close();
  });

  it('throws ProviderError when the Cypher string omits the $rid token', async () => {
    await expect(
      connection.executeQuery('MATCH (n) RETURN n', {}, { repositoryId: 'repo-a' }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws ProviderError when repositoryId is empty', async () => {
    await expect(
      connection.executeQuery(
        'MATCH (n {repositoryId: $rid}) RETURN n',
        {},
        { repositoryId: '' },
      ),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws ProviderError when repositoryId is undefined at runtime', async () => {
    await expect(
      connection.executeQuery(
        'MATCH (n {repositoryId: $rid}) RETURN n',
        {},
        // Reaching past the type system to make sure the runtime guard fires
        // when callers cheat. The driver instance was never used.
        { repositoryId: undefined as unknown as string },
      ),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

// ─── 1b. executeImplicitInTransactions — same isolation contract as executeQuery

describe('Neo4jConnection.executeImplicitInTransactions isolation enforcement', () => {
  it('throws ProviderError when the Cypher string omits the $rid token', async () => {
    const connection = new Neo4jConnection({
      uri: 'bolt://localhost:7687',
      username: 'neo4j',
      password: 'unused',
    });
    try {
      await expect(
        connection.executeImplicitInTransactions(
          'CALL () { MATCH (n) DETACH DELETE n } IN TRANSACTIONS OF 500 ROWS',
          {},
          { repositoryId: 'repo-a' },
        ),
      ).rejects.toBeInstanceOf(ProviderError);
    } finally {
      await connection.close();
    }
  });

  it('throws ProviderError when repositoryId is empty', async () => {
    const connection = new Neo4jConnection({
      uri: 'bolt://localhost:7687',
      username: 'neo4j',
      password: 'unused',
    });
    try {
      await expect(
        connection.executeImplicitInTransactions(
          'CALL () { MATCH (n {repositoryId: $rid}) DETACH DELETE n } IN TRANSACTIONS OF 500 ROWS',
          {},
          { repositoryId: '' },
        ),
      ).rejects.toBeInstanceOf(ProviderError);
    } finally {
      await connection.close();
    }
  });
});

// ─── 2. executeSystemQuery — crossRepository flag enforced ───────────────

describe('Neo4jConnection.executeSystemQuery', () => {
  it('throws ProviderError when crossRepository is not true', async () => {
    const connection = new Neo4jConnection({
      uri: 'bolt://localhost:7687',
      username: 'neo4j',
      password: 'unused',
    });
    try {
      await expect(
        connection.executeSystemQuery(
          'RETURN 1',
          {},
          // Caller cheats around the type — crossRepository must be exactly true.
          { crossRepository: false as unknown as true },
        ),
      ).rejects.toBeInstanceOf(ProviderError);
    } finally {
      await connection.close();
    }
  });
});

// ─── 3. Grep-based isolation lock — only Neo4jConnection touches the driver ─

describe('Isolation chokepoint static enforcement', () => {
  const FORBIDDEN_PATTERNS = [
    /from\s+['"]neo4j-driver['"]/,
    /require\(['"]neo4j-driver['"]\)/,
    /\bdriver\.session\s*\(/,
    /\bdriver\.executeQuery\s*\(/,
  ];

  const ALLOWED_FILES = new Set(['Neo4jConnection.ts', 'Neo4jConnection.test.ts']);

  it('no src/*.ts file other than Neo4jConnection.ts references neo4j-driver runtime APIs', () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of listTsFiles(SRC_DIR)) {
      const name = basename(file);
      if (ALLOWED_FILES.has(name)) continue;
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        if (FORBIDDEN_PATTERNS.some((pat) => pat.test(line))) {
          offenders.push({ file: name, line: i + 1, text: line.trim() });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// ─── 4. Notifications surface — driver-mock unit test ──────────────────

describe('Neo4jConnection notifications surface', () => {
  const URI = 'bolt://localhost:7687';

  it('emits one console.warn when summary.notifications carries a non-trivial entry', async () => {
    const connection = new Neo4jConnection({
      uri: URI,
      username: 'neo4j',
      password: 'unused',
    });
    try {
      // Swap the private driver with a stub that returns a known summary
      // shape — the chokepoint should warn when the notifications array is
      // non-empty (the P15-validated rule).
      const stubDriver = {
        executeQuery: async () => ({
          records: [],
          summary: {
            notifications: [
              {
                severity: undefined,
                category: 'PERFORMANCE',
                code: 'Neo.ClientNotification.Statement.CartesianProduct',
                title: 'cartesian product',
                description: 'disconnected pattern',
              },
            ],
            gqlStatusObjects: [
              {
                severity: 'INFORMATION',
                classification: 'PERFORMANCE',
                gqlStatus: '03N90',
                description: 'cartesian product (downgraded to INFORMATION in GQL)',
              },
            ],
            counters: { updates: () => ({}) },
            resultAvailableAfter: 5n,
            resultConsumedAfter: 1n,
          },
          keys: [],
        }),
      };
      const c = connection as unknown as { driver: typeof stubDriver };
      c.driver = stubDriver;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await connection.executeQuery(
          'MATCH (a:_Entity {repositoryId: $rid}), (b:_Entity {repositoryId: $rid}) RETURN a, b LIMIT 1',
          {},
          { repositoryId: 'repo-warn' },
        );
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const callArgs = warnSpy.mock.calls[0];
        expect(callArgs?.[0]).toBe('[neo4j] notifications');
        const payload = callArgs?.[1] as {
          cypher: string;
          notifications: Array<{ category: string; code: string }>;
        };
        expect(payload.cypher).toContain('MATCH');
        expect(payload.notifications.some((n) => n.category === 'PERFORMANCE')).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      await connection.close().catch(() => {});
    }
  });

  it('does not warn when there are only INFORMATION / UNKNOWN GQL entries and no legacy notifications', async () => {
    const connection = new Neo4jConnection({
      uri: URI,
      username: 'neo4j',
      password: 'unused',
    });
    try {
      const stubDriver = {
        executeQuery: async () => ({
          records: [],
          summary: {
            notifications: [],
            gqlStatusObjects: [
              {
                severity: 'INFORMATION',
                classification: 'UNKNOWN',
                gqlStatus: '00000',
                description: 'successful completion',
              },
              {
                severity: 'UNKNOWN',
                classification: 'UNKNOWN',
                gqlStatus: '02000',
                description: 'no data',
              },
            ],
            counters: { updates: () => ({}) },
            resultAvailableAfter: 1n,
            resultConsumedAfter: 0n,
          },
          keys: [],
        }),
      };
      const c = connection as unknown as { driver: typeof stubDriver };
      c.driver = stubDriver;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await connection.executeQuery(
          'MATCH (n {repositoryId: $rid}) RETURN n LIMIT 1',
          {},
          { repositoryId: 'repo-clean' },
        );
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      await connection.close().catch(() => {});
    }
  });

  it('also warns on WARNING-severity gqlStatusObjects when the legacy array is empty', async () => {
    const connection = new Neo4jConnection({
      uri: URI,
      username: 'neo4j',
      password: 'unused',
    });
    try {
      const stubDriver = {
        executeQuery: async () => ({
          records: [],
          summary: {
            notifications: [],
            gqlStatusObjects: [
              {
                severity: 'WARNING',
                classification: 'UNRECOGNIZED',
                gqlStatus: '01N50',
                description: 'label does not exist',
              },
            ],
            counters: { updates: () => ({}) },
            resultAvailableAfter: 2n,
            resultConsumedAfter: 0n,
          },
          keys: [],
        }),
      };
      const c = connection as unknown as { driver: typeof stubDriver };
      c.driver = stubDriver;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await connection.executeQuery(
          'MATCH (n:_DoesNotExist {repositoryId: $rid}) RETURN n',
          {},
          { repositoryId: 'repo-warn-gql' },
        );
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const payload = warnSpy.mock.calls[0]?.[1] as {
          notifications: Array<{ severity: string }>;
        };
        expect(payload.notifications.some((n) => n.severity === 'WARNING')).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      await connection.close().catch(() => {});
    }
  });
});
