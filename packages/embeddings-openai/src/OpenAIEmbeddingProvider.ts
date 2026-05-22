// OpenAI-compatible EmbeddingProvider — works with vLLM, OpenAI, Azure, Ollama, etc.

import type { EmbeddingProvider } from '@utaba/deep-memory/providers';
import type { UsageSink } from '@utaba/deep-memory/types';
import { ProviderError, createSafeSink } from '@utaba/deep-memory';

const PROVIDER_NAME = 'openai';

/** Configuration for the OpenAI-compatible embedding provider */
export interface OpenAIEmbeddingProviderConfig {
  /** Base URL of the embeddings API (e.g. "http://localhost:8010") */
  baseUrl: string;

  /** Model identifier sent in requests (e.g. "Qwen/Qwen3-Embedding-8B") */
  model: string;

  /** Dimensionality of the embedding vectors. Auto-detected on first call if omitted. */
  dimensions?: number;

  /** API key for authenticated endpoints. Optional for local servers. */
  apiKey?: string;

  /** Request timeout in milliseconds. Default: 30000 */
  timeoutMs?: number;

  /** Maximum texts per batch request. Default: 64 */
  maxBatchSize?: number;

  /**
   * Optional usage sink. When provided, the provider emits one
   * {@link OperationUsage} record per `embed`/`embedBatch` call reporting
   * prompt tokens consumed. Multi-chunk `embedBatch` aggregates across
   * chunks into a single record.
   */
  reportUsage?: UsageSink;
}

/** Response shape from the OpenAI /v1/embeddings endpoint */
interface EmbeddingsResponse {
  object: string;
  data: Array<{ object: string; index: number; embedding: number[] }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly _baseUrl: string;
  private readonly _model: string;
  private readonly _apiKey: string | undefined;
  private readonly _timeoutMs: number;
  private readonly _maxBatchSize: number;
  private readonly _reportUsage: UsageSink | undefined;
  private _dimensions: number | undefined;

  constructor(config: OpenAIEmbeddingProviderConfig) {
    this._baseUrl = config.baseUrl.replace(/\/+$/, '');
    this._model = config.model;
    this._apiKey = config.apiKey;
    this._timeoutMs = config.timeoutMs ?? 30_000;
    this._maxBatchSize = config.maxBatchSize ?? 64;
    this._dimensions = config.dimensions;
    this._reportUsage = createSafeSink(config.reportUsage);
  }

  async embed(text: string): Promise<number[]> {
    let totalPromptTokens = 0;
    let totalTokens = 0;
    let calls = 0;
    try {
      const response = await this._request([text]);
      totalPromptTokens += response.usage?.prompt_tokens ?? 0;
      totalTokens += response.usage?.total_tokens ?? 0;
      calls++;
      const vector = response.data[0]?.embedding;
      if (!vector) {
        throw new ProviderError(
          'OpenAI embeddings API returned no data',
          'Check that the model is loaded and the endpoint is responding correctly.',
        );
      }
      this._resolveDimensions(vector);
      return vector;
    } finally {
      this._emitUsage('embed', totalPromptTokens, totalTokens, calls);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = [];
    let totalPromptTokens = 0;
    let totalTokens = 0;
    let calls = 0;

    try {
      // Chunk into maxBatchSize to avoid overloading the server
      for (let i = 0; i < texts.length; i += this._maxBatchSize) {
        const chunk = texts.slice(i, i + this._maxBatchSize);
        const response = await this._request(chunk);
        totalPromptTokens += response.usage?.prompt_tokens ?? 0;
        totalTokens += response.usage?.total_tokens ?? 0;
        calls++;

        // Sort by index to guarantee order matches input
        const sorted = response.data.sort((a, b) => a.index - b.index);
        for (const item of sorted) {
          results.push(item.embedding);
        }
      }

      if (results.length > 0 && results[0]) {
        this._resolveDimensions(results[0]);
      }

      return results;
    } finally {
      this._emitUsage('embedBatch', totalPromptTokens, totalTokens, calls);
    }
  }

  private _emitUsage(operation: string, promptTokens: number, totalTokens: number, calls: number): void {
    if (!this._reportUsage || calls === 0) return;
    this._reportUsage({
      provider: PROVIDER_NAME,
      operation,
      unit: 'tokens',
      value: totalTokens,
      timestamp: new Date(),
      details: { promptTokens, totalTokens, calls },
    });
  }

  dimensions(): number {
    if (this._dimensions === undefined) {
      throw new ProviderError(
        'Embedding dimensions not yet known. Call embed() first or provide dimensions in config.',
        'Either set dimensions in OpenAIEmbeddingProviderConfig, or call embed() once before calling dimensions().',
      );
    }
    return this._dimensions;
  }

  modelId(): string {
    return this._model;
  }

  similarity(a: number[], b: number[]): number {
    return cosineSimilarity(a, b);
  }

  private async _request(input: string[]): Promise<EmbeddingsResponse> {
    const url = `${this._baseUrl}/v1/embeddings`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this._apiKey) {
      headers['Authorization'] = `Bearer ${this._apiKey}`;
    }

    const requestBody: { input: string[]; model: string; dimensions?: number } = {
      input,
      model: this._model,
    };
    if (this._dimensions !== undefined) {
      requestBody.dimensions = this._dimensions;
    }
    const body = JSON.stringify(requestBody);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this._timeoutMs),
      });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new ProviderError(
          `Embedding request timed out after ${this._timeoutMs}ms`,
          `Increase timeoutMs in config, reduce batch size, or check server health at ${this._baseUrl}/health`,
        );
      }
      throw new ProviderError(
        `Failed to connect to embedding server: ${error instanceof Error ? error.message : String(error)}`,
        `Check that the server is running at ${this._baseUrl}`,
      );
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new ProviderError(
        `Embedding API returned ${response.status}: ${errorBody}`,
        response.status === 401
          ? 'Check your API key in OpenAIEmbeddingProviderConfig.'
          : `Check the embedding server logs. URL: ${url}`,
      );
    }

    return (await response.json()) as EmbeddingsResponse;
  }

  private _resolveDimensions(vector: number[]): void {
    if (this._dimensions === undefined) {
      this._dimensions = vector.length;
    }
  }
}

/** Cosine similarity between two vectors */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
