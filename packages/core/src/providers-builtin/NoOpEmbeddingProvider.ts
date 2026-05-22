// NoOpEmbeddingProvider — stub used when no embedding provider is configured

import type { EmbeddingProvider } from '../providers/EmbeddingProvider.js';
import { EmbeddingProviderRequiredError } from '../core/errors.js';

export class NoOpEmbeddingProvider implements EmbeddingProvider {
  async embed(_text: string): Promise<number[]> {
    throw new EmbeddingProviderRequiredError();
  }

  async embedBatch(_texts: string[]): Promise<number[][]> {
    throw new EmbeddingProviderRequiredError();
  }

  dimensions(): number {
    return 0;
  }

  modelId(): string {
    return 'none';
  }
}
