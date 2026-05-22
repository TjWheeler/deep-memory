// Tests for DeepMemory.reembedAll — global-bus events and AbortSignal handling

import { describe, it, expect, beforeEach } from 'vitest';
import { DeepMemory } from './DeepMemory.js';
import { InMemoryStorageProvider } from '../providers-builtin/InMemoryStorageProvider.js';
import { OperationAbortedError } from './errors.js';
import type { EmbeddingProvider, EmbeddingProviderFactory } from '../providers/EmbeddingProvider.js';
import type { MemoryRepository } from './MemoryRepository.js';

const REPO_ID = '70000000-0000-4000-a000-000000000001';

function createFakeEmbeddingFactory(): EmbeddingProviderFactory {
  return ({ model, dimensions }): EmbeddingProvider => {
    const dim = dimensions ?? 4;
    const hash = (text: string): number[] => {
      const vec = new Array(dim).fill(0);
      for (let i = 0; i < text.length; i++) vec[i % dim] += text.charCodeAt(i) / 256;
      const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      return mag > 0 ? vec.map((v) => v / mag) : vec;
    };
    return {
      async embed(text: string) { return hash(text); },
      async embedBatch(texts: string[]) { return texts.map(hash); },
      dimensions() { return dim; },
      modelId() { return model; },
    };
  };
}

describe('DeepMemory.reembedAll', () => {
  let memory: DeepMemory;
  let repo: MemoryRepository;

  beforeEach(async () => {
    memory = new DeepMemory({
      storage: new InMemoryStorageProvider(),
      embeddingFactory: createFakeEmbeddingFactory(),
      defaultEmbeddingModel: 'fake-model-v1',
      defaultEmbeddingDimensions: 4,
      provenance: { actorId: 'test', actorType: 'agent' },
    });

    repo = await memory.createRepository({
      repositoryId: REPO_ID,
      label: 'Reembed Test',
      vocabulary: { entityTypes: [{ type: 'thing', description: 't' }], relationshipTypes: [] },
      governance: { mode: 'open' },
    });

    // Populate enough entities to span multiple batches at batchSize=2
    await repo.createEntities([
      { entityType: 'thing', label: 'A' },
      { entityType: 'thing', label: 'B' },
      { entityType: 'thing', label: 'C' },
      { entityType: 'thing', label: 'D' },
      { entityType: 'thing', label: 'E' },
    ]);
  });

  it('emits reembed:started, reembed:progress, reembed:completed on the global bus', async () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    memory.on('reembed:started', (e) => { events.push({ type: 'reembed:started', payload: e }); });
    memory.on('reembed:progress', (e) => { events.push({ type: 'reembed:progress', payload: e }); });
    memory.on('reembed:completed', (e) => { events.push({ type: 'reembed:completed', payload: e }); });

    const result = await memory.reembedAll(REPO_ID, { batchSize: 2 });

    expect(result.processed).toBe(5);
    expect(result.failed).toBe(0);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('reembed:started');
    expect(types[types.length - 1]).toBe('reembed:completed');
    expect(types.filter((t) => t === 'reembed:progress').length).toBeGreaterThan(0);
  });

  it('aborts at batch boundary and emits reembed:failed', async () => {
    const failedEvents: unknown[] = [];
    memory.on('reembed:failed', (e) => { failedEvents.push(e); });

    const controller = new AbortController();
    controller.abort();

    await expect(memory.reembedAll(REPO_ID, { batchSize: 2, signal: controller.signal }))
      .rejects.toBeInstanceOf(OperationAbortedError);

    expect(failedEvents).toHaveLength(1);
  });

  it('honours abort at batch boundary — at least one batch completes before stop', async () => {
    const controller = new AbortController();
    const progressEvents: Array<{ processed: number; totalEntities: number }> = [];

    memory.on('reembed:progress', (e) => {
      progressEvents.push({ processed: e.payload.processed, totalEntities: e.payload.totalEntities });
      // Abort after the first batch completes
      if (progressEvents.length === 1) controller.abort();
    });

    await expect(memory.reembedAll(REPO_ID, { batchSize: 2, signal: controller.signal }))
      .rejects.toBeInstanceOf(OperationAbortedError);

    // The progress event proves a batch wrote vectors before abort took effect.
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    const lastProgress = progressEvents[progressEvents.length - 1]!;
    expect(lastProgress.processed).toBeGreaterThan(0);
    expect(lastProgress.processed).toBeLessThan(lastProgress.totalEntities);
  });
});
