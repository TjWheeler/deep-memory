// Unit tests for the `vocabularyCacheTtlMs` option. The provider runs over a
// fake pool that answers the vocabulary read and counts how many times the
// database is asked, and the clock is faked so the TTL can be crossed
// without waiting.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type sql from 'mssql';
import { InvalidInputError, createEmptyVocabulary } from '@utaba/deep-memory';
import type { MemoryVocabulary } from '@utaba/deep-memory/types';
import { SqlServerStorageProvider, type SqlServerStorageProviderConfig } from './SqlServerStorageProvider.js';

const RID = '50000000-0000-4000-a000-000000000004';

interface FakeResult {
  recordset: unknown[];
  recordsets: unknown[][];
  rowsAffected: number[];
}

/** The fake store: whether the repository exists, its vocabulary version, and how writes answer. */
interface FakeStore {
  exists: boolean;
  version: string;
  saveFails: boolean;
  /** When set, the next vocabulary read waits for this before answering. */
  readGate?: Promise<void>;
}

function vocabulary(version: string): MemoryVocabulary {
  return { ...createEmptyVocabulary('test'), version };
}

function providerOver(config: Partial<SqlServerStorageProviderConfig>) {
  const store: FakeStore = { exists: true, version: '1.0.0', saveFails: false };
  let reads = 0;

  async function answer(text: string): Promise<unknown[]> {
    if (text.includes('LEFT JOIN') && text.includes('dm_vocabularies')) {
      reads += 1;
      const gate = store.readGate;
      store.readGate = undefined;
      const snapshot = store.exists ? [{ vocabulary: JSON.stringify(vocabulary(store.version)) }] : [];
      if (gate !== undefined) await gate;
      return snapshot;
    }
    if (text.includes("JSON_VALUE([vocabulary], '$.version')")) {
      if (store.saveFails) throw Object.assign(new Error('connection reset'), { name: 'RequestError' });
      return [{ repository_exists: store.exists ? 1 : 0, updated: store.exists ? 1 : 0, vocabulary_exists: 1, stored_version: null }];
    }
    if (text.includes('XLOCK')) {
      const repositories = store.exists ? 1 : 0;
      store.exists = false;
      return [{ relationships: 0, entities: 0, repositories }];
    }
    if (text.includes('SELECT * FROM') && text.includes('dm_repositories')) {
      return store.exists ? [{ repository_id: RID, label: 'r', governance_config: '{"mode":"open"}' }] : [];
    }
    return [];
  }

  interface FakeRequest {
    input(): FakeRequest;
    query(text: string): Promise<FakeResult>;
  }
  const request: FakeRequest = {
    input(): FakeRequest {
      return request;
    },
    async query(text: string): Promise<FakeResult> {
      const recordset = await answer(text);
      return { recordset, recordsets: [recordset], rowsAffected: [recordset.length] };
    },
  };
  const provider = new SqlServerStorageProvider({ connection: { server: 'unused', database: 'unused' }, ...config });
  (provider as unknown as { pool: Pick<sql.ConnectionPool, 'request'> }).pool = {
    request: () => request as unknown as sql.Request,
  };
  return { provider, store, reads: () => reads };
}

describe('SqlServerStorageProvider vocabulary cache TTL', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a read for 60 s by default, then reads the stored vocabulary again', async () => {
    const { provider, store, reads } = providerOver({});

    await provider.getVocabulary(RID);
    store.version = '2.0.0';
    vi.advanceTimersByTime(59_999);
    expect((await provider.getVocabulary(RID)).version).toBe('1.0.0');
    expect(reads()).toBe(1);

    vi.advanceTimersByTime(1);
    expect((await provider.getVocabulary(RID)).version).toBe('2.0.0');
    expect(reads()).toBe(2);
  });

  it('honours a configured TTL', async () => {
    const { provider, store, reads } = providerOver({ vocabularyCacheTtlMs: 5_000 });

    await provider.getVocabulary(RID);
    store.version = '2.0.0';
    vi.advanceTimersByTime(4_999);
    expect((await provider.getVocabulary(RID)).version).toBe('1.0.0');

    vi.advanceTimersByTime(1);
    expect((await provider.getVocabulary(RID)).version).toBe('2.0.0');
    expect(reads()).toBe(2);
  });

  it('reads the stored vocabulary every time when the TTL is 0', async () => {
    const { provider, store, reads } = providerOver({ vocabularyCacheTtlMs: 0 });

    await provider.getVocabulary(RID);
    store.version = '2.0.0';
    expect((await provider.getVocabulary(RID)).version).toBe('2.0.0');
    expect(reads()).toBe(2);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('refuses a TTL of %s at construction', (value) => {
    expect(
      () => new SqlServerStorageProvider({ connection: { server: 'unused', database: 'unused' }, vocabularyCacheTtlMs: value }),
    ).toThrow(InvalidInputError);
  });

  it('bypasses the cache on a fresh read and caches what it read', async () => {
    const { provider, store, reads } = providerOver({});

    await provider.getVocabulary(RID);
    store.version = '2.0.0';
    expect((await provider.getVocabulary(RID, { fresh: true })).version).toBe('2.0.0');
    expect((await provider.getVocabulary(RID)).version).toBe('2.0.0');
    expect(reads()).toBe(2);
  });

  it('drops the entry when saveVocabulary lands', async () => {
    const { provider, store, reads } = providerOver({});

    await provider.getVocabulary(RID);
    store.version = '2.0.0';
    await provider.saveVocabulary(RID, vocabulary('2.0.0'), '1.0.0');
    expect((await provider.getVocabulary(RID)).version).toBe('2.0.0');
    expect(reads()).toBe(2);
  });

  it('drops the entry when saveVocabulary fails', async () => {
    const { provider, store, reads } = providerOver({});

    await provider.getVocabulary(RID);
    store.version = '2.0.0';
    store.saveFails = true;
    await expect(provider.saveVocabulary(RID, vocabulary('3.0.0'), '1.0.0')).rejects.toMatchObject({ name: 'ProviderError' });
    expect((await provider.getVocabulary(RID)).version).toBe('2.0.0');
    expect(reads()).toBe(2);
  });

  it('drops the entry when the repository is deleted, so the next read reports it missing', async () => {
    const { provider } = providerOver({});

    await provider.getVocabulary(RID);
    await provider.deleteRepository(RID);
    await expect(provider.getVocabulary(RID)).rejects.toMatchObject({ name: 'RepositoryNotFoundError' });
  });

  it('drops the entry when another call finds the repository missing', async () => {
    const { provider, store, reads } = providerOver({});

    await provider.getVocabulary(RID);
    store.exists = false;
    await expect(provider.deleteAllContents(RID)).rejects.toMatchObject({ name: 'RepositoryNotFoundError' });
    await expect(provider.getVocabulary(RID)).rejects.toMatchObject({ name: 'RepositoryNotFoundError' });
    expect(reads()).toBe(2);
  });

  it('does not cache a read that an invalidation overtook', async () => {
    const { provider, store, reads } = providerOver({});
    let open: () => void = () => undefined;
    store.readGate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const pending = provider.getVocabulary(RID);
    store.version = '2.0.0';
    await provider.saveVocabulary(RID, vocabulary('2.0.0'), '1.0.0');
    open();
    expect((await pending).version).toBe('1.0.0');

    expect((await provider.getVocabulary(RID)).version).toBe('2.0.0');
    expect(reads()).toBe(2);
  });

  it('reads the stored vocabulary for repository stats', async () => {
    const { provider, store, reads } = providerOver({});

    await provider.getVocabulary(RID);
    store.version = '2.0.0';
    expect((await provider.getRepositoryStats(RID)).vocabularyVersion).toBe('2.0.0');
    expect(reads()).toBe(2);
  });
});
