// Unit tests for the `vocabularyCacheTtlMs` option. The provider's connection
// is swapped for a fake that answers the vocabulary read and counts how many
// times the database is asked, and the clock is faked so the TTL can be
// crossed without waiting.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInputError, ProviderError, createEmptyVocabulary } from '@utaba/deep-memory';
import type { Neo4jConnection } from './Neo4jConnection.js';
import { Neo4jStorageProvider, type Neo4jStorageProviderConfig } from './Neo4jStorageProvider.js';
import { VOCABULARY_READ_QUERY, VOCABULARY_SAVE_QUERY } from './queries/vocabulary.js';

const REPOSITORY_ID = 'repo-vocabulary-cache';
const CONNECTION = { uri: 'bolt://localhost:7687', username: 'neo4j', password: 'unused' };

/** A provider whose vocabulary reads go to a fake; `version` is what the store holds now. */
function providerOver(config: Partial<Neo4jStorageProviderConfig>) {
  let reads = 0;
  let version = '1.0.0';
  /** When set, the next vocabulary read waits for this before answering. */
  let readGate: Promise<void> | undefined;
  const fake = {
    async executeQuery(cypher: string) {
      // A save fails as a connection error would: whether it landed is unknown.
      if (cypher === VOCABULARY_SAVE_QUERY) throw new Error('connection reset');
      if (cypher !== VOCABULARY_READ_QUERY) throw new Error(`unexpected statement: ${cypher}`);
      reads += 1;
      const gate = readGate;
      readGate = undefined;
      const values: Record<string, unknown> = {
        repositoryExists: true,
        json: JSON.stringify({ version, entityTypes: [], relationshipTypes: [] }),
      };
      if (gate !== undefined) await gate;
      return { records: [{ get: (key: string) => values[key] }] };
    },
  };
  const provider = new Neo4jStorageProvider({ ...CONNECTION, ...config });
  (provider as unknown as { connection: Neo4jConnection }).connection = fake as unknown as Neo4jConnection;
  return {
    provider,
    reads: () => reads,
    storeVersion: (next: string) => {
      version = next;
    },
    /** Hold the next vocabulary read after it has seen the store; call the result to let it answer. */
    holdNextRead: (): (() => void) => {
      let open: () => void = () => undefined;
      readGate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return open;
    },
  };
}

describe('Neo4jStorageProvider vocabulary cache TTL', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a read for 60 s by default, then reads the stored vocabulary again', async () => {
    const { provider, reads, storeVersion } = providerOver({});

    await provider.getVocabulary(REPOSITORY_ID);
    storeVersion('2.0.0');
    vi.advanceTimersByTime(59_999);
    expect((await provider.getVocabulary(REPOSITORY_ID)).version).toBe('1.0.0');
    expect(reads()).toBe(1);

    vi.advanceTimersByTime(1);
    expect((await provider.getVocabulary(REPOSITORY_ID)).version).toBe('2.0.0');
    expect(reads()).toBe(2);
  });

  it('honours a configured TTL', async () => {
    const { provider, reads, storeVersion } = providerOver({ vocabularyCacheTtlMs: 5_000 });

    await provider.getVocabulary(REPOSITORY_ID);
    storeVersion('2.0.0');
    vi.advanceTimersByTime(4_999);
    expect((await provider.getVocabulary(REPOSITORY_ID)).version).toBe('1.0.0');

    vi.advanceTimersByTime(1);
    expect((await provider.getVocabulary(REPOSITORY_ID)).version).toBe('2.0.0');
    expect(reads()).toBe(2);
  });

  it('applies the configured TTL to the entry a fresh read stores', async () => {
    const { provider, reads } = providerOver({ vocabularyCacheTtlMs: 5_000 });

    await provider.getVocabulary(REPOSITORY_ID, { fresh: true });
    vi.advanceTimersByTime(4_999);
    await provider.getVocabulary(REPOSITORY_ID);
    expect(reads()).toBe(1);

    vi.advanceTimersByTime(1);
    await provider.getVocabulary(REPOSITORY_ID);
    expect(reads()).toBe(2);
  });

  it('reads the stored vocabulary on every call when the TTL is 0', async () => {
    const { provider, reads, storeVersion } = providerOver({ vocabularyCacheTtlMs: 0 });

    await provider.getVocabulary(REPOSITORY_ID, { fresh: true });
    await provider.getVocabulary(REPOSITORY_ID);
    storeVersion('2.0.0');
    expect((await provider.getVocabulary(REPOSITORY_ID)).version).toBe('2.0.0');
    expect(reads()).toBe(3);
  });

  it('drops the cached copy when a save fails for a reason other than a conflict', async () => {
    const { provider, reads, storeVersion } = providerOver({});

    await provider.getVocabulary(REPOSITORY_ID);
    await expect(
      provider.saveVocabulary(REPOSITORY_ID, { ...createEmptyVocabulary('tester'), version: '2.0.0' }, '1.0.0'),
    ).rejects.toBeInstanceOf(ProviderError);
    // The write may have landed before the failure was reported.
    storeVersion('2.0.0');
    expect((await provider.getVocabulary(REPOSITORY_ID)).version).toBe('2.0.0');
    expect(reads()).toBe(2);
  });

  it.each([false, true])('does not cache a read (fresh: %s) that an invalidation overtook', async (fresh) => {
    const { provider, reads, storeVersion, holdNextRead } = providerOver({});
    const open = holdNextRead();

    const pending = provider.getVocabulary(REPOSITORY_ID, { fresh });
    storeVersion('2.0.0');
    await expect(
      provider.saveVocabulary(REPOSITORY_ID, { ...createEmptyVocabulary('tester'), version: '2.0.0' }, '1.0.0'),
    ).rejects.toBeInstanceOf(ProviderError);
    open();
    expect((await pending).version).toBe('1.0.0');

    expect((await provider.getVocabulary(REPOSITORY_ID)).version).toBe('2.0.0');
    expect(reads()).toBe(2);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s at construction', (vocabularyCacheTtlMs) => {
    expect(() => new Neo4jStorageProvider({ ...CONNECTION, vocabularyCacheTtlMs })).toThrow(InvalidInputError);
  });

  it('refuses a value that is not a number at construction', () => {
    // A host config parsed from JSON is not type-checked.
    const hostConfig = JSON.parse('{"vocabularyCacheTtlMs":"60000"}') as Partial<Neo4jStorageProviderConfig>;
    expect(() => new Neo4jStorageProvider({ ...CONNECTION, ...hostConfig })).toThrow(InvalidInputError);
  });
});
