import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIEmbeddingProvider } from './OpenAIEmbeddingProvider.js';

function mockEmbeddingsResponse(embeddings: number[][]) {
  return {
    object: 'list',
    data: embeddings.map((embedding, index) => ({
      object: 'embedding',
      index,
      embedding,
    })),
    model: 'test-model',
    usage: { prompt_tokens: 10, total_tokens: 10 },
  };
}

describe('OpenAIEmbeddingProvider', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns modelId from config', () => {
    const provider = new OpenAIEmbeddingProvider({
      baseUrl: 'http://localhost:8010',
      model: 'Qwen/Qwen3-Embedding-8B',
    });
    expect(provider.modelId()).toBe('Qwen/Qwen3-Embedding-8B');
  });

  it('throws if dimensions() called before embed()', () => {
    const provider = new OpenAIEmbeddingProvider({
      baseUrl: 'http://localhost:8010',
      model: 'test-model',
    });
    expect(() => provider.dimensions()).toThrow('dimensions not yet known');
  });

  it('returns configured dimensions without needing embed()', () => {
    const provider = new OpenAIEmbeddingProvider({
      baseUrl: 'http://localhost:8010',
      model: 'test-model',
      dimensions: 4096,
    });
    expect(provider.dimensions()).toBe(4096);
  });

  it('embed() sends correct request and returns vector', async () => {
    const vector = [0.1, 0.2, 0.3];
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(mockEmbeddingsResponse([vector])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const provider = new OpenAIEmbeddingProvider({
      baseUrl: 'http://localhost:8010',
      model: 'test-model',
    });

    const result = await provider.embed('hello');

    expect(result).toEqual(vector);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, options] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('http://localhost:8010/v1/embeddings');
    expect(options?.method).toBe('POST');

    const body = JSON.parse(options?.body as string);
    expect(body.input).toEqual(['hello']);
    expect(body.model).toBe('test-model');
  });

  it('embed() sends dimensions in request body when configured', async () => {
    const vector = Array.from({ length: 1024 }, () => 0.1);
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(mockEmbeddingsResponse([vector])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const provider = new OpenAIEmbeddingProvider({
      baseUrl: 'http://localhost:8010',
      model: 'Qwen/Qwen3-Embedding-8B',
      dimensions: 1024,
    });

    await provider.embed('hello');

    const [, options] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(options?.body as string);
    expect(body.dimensions).toBe(1024);
  });

  it('embed() omits dimensions from body when not configured', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(mockEmbeddingsResponse([[0.1, 0.2]])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const provider = new OpenAIEmbeddingProvider({
      baseUrl: 'http://localhost:8010',
      model: 'test-model',
    });

    await provider.embed('hello');

    const [, options] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(options?.body as string);
    expect(body.dimensions).toBeUndefined();
  });

  it('embed() auto-detects dimensions', async () => {
    const vector = [0.1, 0.2, 0.3, 0.4];
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(mockEmbeddingsResponse([vector])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const provider = new OpenAIEmbeddingProvider({
      baseUrl: 'http://localhost:8010',
      model: 'test-model',
    });

    await provider.embed('test');
    expect(provider.dimensions()).toBe(4);
  });

  it('embed() never sends an auto-detected native dimension on later calls', async () => {
    // Regression: a server that rejects `dimensions` must keep working across a
    // session. The native size learned from response #1 must not be echoed back.
    const vector = Array.from({ length: 4096 }, () => 0.1);
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify(mockEmbeddingsResponse([vector])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const provider = new OpenAIEmbeddingProvider({
      baseUrl: 'http://localhost:8010',
      model: 'Qwen/Qwen3-Embedding-8B',
    });

    await provider.embed('first');
    expect(provider.dimensions()).toBe(4096);
    await provider.embed('second');

    for (const call of fetchSpy.mock.calls) {
      const body = JSON.parse(call[1]?.body as string);
      expect(body.dimensions).toBeUndefined();
    }
  });

  it('embed() sends configured dimensions on every call', async () => {
    const vector = Array.from({ length: 1024 }, () => 0.1);
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify(mockEmbeddingsResponse([vector])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const provider = new OpenAIEmbeddingProvider({
      baseUrl: 'http://localhost:8010',
      model: 'Qwen/Qwen3-Embedding-8B',
      dimensions: 1024,
    });

    await provider.embed('first');
    await provider.embed('second');

    for (const call of fetchSpy.mock.calls) {
      const body = JSON.parse(call[1]?.body as string);
      expect(body.dimensions).toBe(1024);
    }
  });

  it('embed() throws when the server returns a vector of unexpected length', async () => {
    // Caller requested 1024 (truncation opt-in) but the server ignored it.
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(mockEmbeddingsResponse([[0.1, 0.2, 0.3]])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const provider = new OpenAIEmbeddingProvider({
      baseUrl: 'http://localhost:8010',
      model: 'test-model',
      dimensions: 1024,
    });

    await expect(provider.embed('hello')).rejects.toThrow(
      '3-dimension vector but 1024 was expected',
    );
  });

  it('embed() throws when native vector length changes mid-session', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockEmbeddingsResponse([[0.1, 0.2, 0.3, 0.4]])), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockEmbeddingsResponse([[0.1, 0.2]])), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const provider = new OpenAIEmbeddingProvider({
      baseUrl: 'http://localhost:8010',
      model: 'test-model',
    });

    await provider.embed('first');
    await expect(provider.embed('second')).rejects.toThrow(
      '2-dimension vector but 4 was expected',
    );
  });

  it('embed() sends Authorization header when apiKey provided', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(mockEmbeddingsResponse([[0.1]])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const provider = new OpenAIEmbeddingProvider({
      baseUrl: 'http://localhost:8010',
      model: 'test-model',
      apiKey: 'sk-test-key',
    });

    await provider.embed('test');

    const [, options] = fetchSpy.mock.calls[0]!;
    const headers = options?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test-key');
  });

  it('embedBatch() returns vectors in correct order', async () => {
    const vectors = [
      [0.1, 0.2],
      [0.3, 0.4],
      [0.5, 0.6],
    ];
    // Return out of order to test sorting
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          object: 'list',
          data: [
            { object: 'embedding', index: 2, embedding: vectors[2] },
            { object: 'embedding', index: 0, embedding: vectors[0] },
            { object: 'embedding', index: 1, embedding: vectors[1] },
          ],
          model: 'test-model',
          usage: { prompt_tokens: 10, total_tokens: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const provider = new OpenAIEmbeddingProvider({
      baseUrl: 'http://localhost:8010',
      model: 'test-model',
    });

    const result = await provider.embedBatch(['a', 'b', 'c']);
    expect(result).toEqual(vectors);
  });

  it('embedBatch() returns empty array for empty input', async () => {
    const provider = new OpenAIEmbeddingProvider({
      baseUrl: 'http://localhost:8010',
      model: 'test-model',
    });

    const result = await provider.embedBatch([]);
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('embedBatch() chunks large batches', async () => {
    const makeVector = (i: number) => [i * 0.1];

    // First chunk response
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify(mockEmbeddingsResponse([makeVector(0), makeVector(1)])),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    // Second chunk response
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify(mockEmbeddingsResponse([makeVector(2)])),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const provider = new OpenAIEmbeddingProvider({
      baseUrl: 'http://localhost:8010',
      model: 'test-model',
      maxBatchSize: 2,
    });

    const result = await provider.embedBatch(['a', 'b', 'c']);
    expect(result).toHaveLength(3);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws ProviderError on HTTP error', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 }),
    );

    const provider = new OpenAIEmbeddingProvider({
      baseUrl: 'http://localhost:8010',
      model: 'test-model',
    });

    await expect(provider.embed('test')).rejects.toThrow('returned 500');
  });

  it('throws ProviderError on network failure', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const provider = new OpenAIEmbeddingProvider({
      baseUrl: 'http://localhost:8010',
      model: 'test-model',
    });

    await expect(provider.embed('test')).rejects.toThrow(
      'Failed to connect to embedding server',
    );
  });

  it('similarity() computes cosine similarity', () => {
    const provider = new OpenAIEmbeddingProvider({
      baseUrl: 'http://localhost:8010',
      model: 'test-model',
    });

    // Identical vectors → 1.0
    expect(provider.similarity([1, 0], [1, 0])).toBeCloseTo(1.0);

    // Orthogonal vectors → 0.0
    expect(provider.similarity([1, 0], [0, 1])).toBeCloseTo(0.0);

    // Opposite vectors → -1.0
    expect(provider.similarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  it('strips trailing slashes from baseUrl', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(mockEmbeddingsResponse([[0.1]])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const provider = new OpenAIEmbeddingProvider({
      baseUrl: 'http://localhost:8010/',
      model: 'test-model',
    });

    await provider.embed('test');

    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('http://localhost:8010/v1/embeddings');
  });

  describe('usage reporting', () => {
    it('reports tokens once per embed() call', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
          model: 'test-model',
          usage: { prompt_tokens: 7, total_tokens: 7 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );

      const sink = vi.fn();
      const provider = new OpenAIEmbeddingProvider({
        baseUrl: 'http://localhost:8010',
        model: 'test-model',
        reportUsage: sink,
      });

      await provider.embed('hello');

      expect(sink).toHaveBeenCalledTimes(1);
      const [usage] = sink.mock.calls[0]!;
      expect(usage.provider).toBe('openai');
      expect(usage.operation).toBe('embed');
      expect(usage.unit).toBe('tokens');
      expect(usage.value).toBe(7);
      expect(usage.details).toEqual({ promptTokens: 7, totalTokens: 7, calls: 1 });
      expect(usage.timestamp).toBeInstanceOf(Date);
    });

    it('aggregates usage across chunked embedBatch() calls', async () => {
      // Batch of 3 with maxBatchSize=2 — should produce 2 HTTP calls and 1 sink emission
      fetchSpy
        .mockResolvedValueOnce(new Response(JSON.stringify({
          object: 'list',
          data: [
            { object: 'embedding', index: 0, embedding: [0.1] },
            { object: 'embedding', index: 1, embedding: [0.2] },
          ],
          model: 'm', usage: { prompt_tokens: 4, total_tokens: 4 },
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: [0.3] }],
          model: 'm', usage: { prompt_tokens: 3, total_tokens: 3 },
        }), { status: 200 }));

      const sink = vi.fn();
      const provider = new OpenAIEmbeddingProvider({
        baseUrl: 'http://localhost:8010',
        model: 'test-model',
        maxBatchSize: 2,
        reportUsage: sink,
      });

      await provider.embedBatch(['a', 'b', 'c']);

      expect(sink).toHaveBeenCalledTimes(1);
      const [usage] = sink.mock.calls[0]!;
      expect(usage.operation).toBe('embedBatch');
      expect(usage.value).toBe(7);
      expect(usage.details).toEqual({ promptTokens: 7, totalTokens: 7, calls: 2 });
    });

    it('still emits usage when embed() throws (fail-safe)', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({
          object: 'list',
          data: [],
          model: 'test-model',
          usage: { prompt_tokens: 5, total_tokens: 5 },
        }), { status: 200 }),
      );

      const sink = vi.fn();
      const provider = new OpenAIEmbeddingProvider({
        baseUrl: 'http://localhost:8010',
        model: 'test-model',
        reportUsage: sink,
      });

      await expect(provider.embed('hello')).rejects.toThrow('returned no data');
      expect(sink).toHaveBeenCalledTimes(1);
    });

    it('a throwing sink does not break the call', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: [0.1] }],
          model: 'm', usage: { prompt_tokens: 1, total_tokens: 1 },
        }), { status: 200 }),
      );

      const provider = new OpenAIEmbeddingProvider({
        baseUrl: 'http://localhost:8010',
        model: 'test-model',
        reportUsage: () => { throw new Error('sink is broken'); },
      });

      const result = await provider.embed('hello');
      expect(result).toEqual([0.1]);
    });
  });
});
