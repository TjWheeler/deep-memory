import { describe, it, expect } from 'vitest';
import { SemanticDeduplicator } from './SemanticDeduplicator.js';
import type { EmbeddingProvider } from '../providers/EmbeddingProvider.js';

const existingTypes = [
  { type: 'person', description: 'A human person' },
  { type: 'project', description: 'A work project' },
  { type: 'component', description: 'A software component' },
  { type: 'clause', description: 'A legal clause' },
];

describe('SemanticDeduplicator (string similarity)', () => {
  const dedup = new SemanticDeduplicator({ similarityThreshold: 0.85 });

  it('detects exact match (normalized)', async () => {
    const result = await dedup.checkDuplicate('person', 'A person', existingTypes);
    expect(result.isDuplicate).toBe(true);
    expect(result.matches[0]!.type).toBe('person');
    expect(result.matches[0]!.similarity).toBe(1.0);
  });

  it('detects exact match with different casing', async () => {
    const result = await dedup.checkDuplicate('Person', 'A person', existingTypes);
    expect(result.isDuplicate).toBe(true);
    expect(result.matches[0]!.type).toBe('person');
  });

  it('detects exact match with different separators', async () => {
    const dedup2 = new SemanticDeduplicator({ similarityThreshold: 0.85 });
    const types = [{ type: 'works_on', description: 'Works on relationship' }];
    const result = await dedup2.checkDuplicate('works-on', 'Works on', types);
    expect(result.isDuplicate).toBe(true);
  });

  it('returns no duplicate for genuinely different types', async () => {
    const result = await dedup.checkDuplicate(
      'jurisdiction',
      'A legal jurisdiction',
      existingTypes,
    );
    expect(result.isDuplicate).toBe(false);
    expect(result.matches).toHaveLength(0);
  });

  it('returns empty when no existing types', async () => {
    const result = await dedup.checkDuplicate('anything', 'Something', []);
    expect(result.isDuplicate).toBe(false);
    expect(result.matches).toHaveLength(0);
  });

  it('uses configurable threshold', async () => {
    // Very low threshold — should catch more
    const lowThreshold = new SemanticDeduplicator({ similarityThreshold: 0.6 });
    const result = await lowThreshold.checkDuplicate('persons', 'People', existingTypes);
    // "persons" vs "person" should be above 0.6 with Jaro-Winkler
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
  });
});

describe('SemanticDeduplicator (with EmbeddingProvider)', () => {
  // Simple mock embedding provider that returns deterministic vectors
  const mockEmbeddingProvider: EmbeddingProvider = {
    async embed(text: string): Promise<number[]> {
      // Generate a simple hash-based vector
      return hashVector(text);
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return texts.map(hashVector);
    },
    dimensions(): number {
      return 4;
    },
    modelId(): string {
      return 'mock-v1';
    },
  };

  function hashVector(text: string): number[] {
    // Map similar texts to similar vectors, different texts to different vectors
    const lower = text.toLowerCase();
    if (lower.includes('person')) return [0.9, 0.1, 0.0, 0.0];
    if (lower.includes('people')) return [0.85, 0.15, 0.0, 0.0]; // similar to person
    if (lower.includes('project')) return [0.0, 0.9, 0.1, 0.0];
    if (lower.includes('clause')) return [0.0, 0.0, 0.9, 0.1];
    if (lower.includes('jurisdiction')) return [0.0, 0.0, 0.1, 0.9];
    return [0.25, 0.25, 0.25, 0.25]; // generic
  }

  const dedup = new SemanticDeduplicator({
    similarityThreshold: 0.9,
    embeddingProvider: mockEmbeddingProvider,
  });

  it('detects exact match before using embeddings', () => {
    const result = dedup.checkDuplicate('person', 'A person', existingTypes);
    return result.then((r) => {
      expect(r.isDuplicate).toBe(true);
      expect(r.matches[0]!.similarity).toBe(1.0);
    });
  });

  it('detects semantic duplicate via embeddings', () => {
    const result = dedup.checkDuplicate('people', 'Human people', existingTypes);
    return result.then((r) => {
      expect(r.isDuplicate).toBe(true);
      expect(r.matches.some((m) => m.type === 'person')).toBe(true);
    });
  });

  it('no duplicate for unrelated type', () => {
    const result = dedup.checkDuplicate('jurisdiction', 'Legal jurisdiction', existingTypes);
    return result.then((r) => {
      // jurisdiction vector is far from all existing types
      expect(r.isDuplicate).toBe(false);
    });
  });
});
