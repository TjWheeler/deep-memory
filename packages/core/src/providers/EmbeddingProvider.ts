// EmbeddingProvider — optional vector embedding interface

/**
 * EmbeddingProvider — enables semantic search and vocabulary deduplication.
 *
 * Optional. When not provided:
 * - `searchByConcept` throws EmbeddingProviderRequiredError
 * - Vocabulary deduplication falls back to string similarity (Jaro-Winkler)
 * - Entity creation skips embedding generation
 */
export interface EmbeddingProvider {
  /** Generate a single embedding vector */
  embed(text: string): Promise<number[]>;

  /** Generate embeddings in batch (more efficient for bulk operations) */
  embedBatch(texts: string[]): Promise<number[][]>;

  /** The dimensionality of the embedding vectors (e.g., 1536, 768) */
  dimensions(): number;

  /** Identifier for the model used — stored with embeddings for compatibility tracking */
  modelId(): string;

  /**
   * Compute cosine similarity between two vectors.
   * Default implementation provided by the library — override for optimized hardware paths.
   */
  similarity?(a: number[], b: number[]): number;
}

/**
 * Factory that produces an EmbeddingProvider configured for a specific model + dimensionality.
 *
 * DeepMemory calls this once per repository when the repo is opened or created,
 * using the repo's stored embedding metadata. Infrastructure concerns (base URL,
 * API key) are captured in the factory closure; model + dimensions come from the
 * repository itself, so different repositories can use different embedding
 * configurations without any global state.
 */
export type EmbeddingProviderFactory = (config: {
  model: string;
  dimensions: number;
}) => EmbeddingProvider;
