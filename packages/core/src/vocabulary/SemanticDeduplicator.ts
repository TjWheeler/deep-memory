// SemanticDeduplicator — detects duplicate type proposals using string or embedding similarity

import type { EmbeddingProvider } from '../providers/EmbeddingProvider.js';
import { jaroWinklerSimilarity, normalizeTypeName } from './similarity.js';

/** A match found during deduplication */
export interface DeduplicationMatch {
  type: string;
  description: string;
  similarity: number;
}

/** Result of a deduplication check */
export interface DeduplicationResult {
  isDuplicate: boolean;
  matches: DeduplicationMatch[];
}

/** An existing type to check against */
export interface ExistingType {
  type: string;
  description: string;
}

export interface SemanticDeduplicatorConfig {
  /** Similarity threshold above which a proposed type is considered a duplicate (default 0.85) */
  similarityThreshold?: number;
  /** Optional embedding provider for semantic comparison */
  embeddingProvider?: EmbeddingProvider;
}

const DEFAULT_THRESHOLD = 0.85;

export class SemanticDeduplicator {
  private readonly threshold: number;
  private readonly embeddingProvider?: EmbeddingProvider;

  constructor(config: SemanticDeduplicatorConfig = {}) {
    this.threshold = config.similarityThreshold ?? DEFAULT_THRESHOLD;
    this.embeddingProvider = config.embeddingProvider;
  }

  /**
   * Check whether a proposed type name is a duplicate of an existing type.
   * Uses embedding similarity if an EmbeddingProvider is available, otherwise falls back
   * to Jaro-Winkler string similarity on normalized type names.
   */
  async checkDuplicate(
    proposedType: string,
    proposedDescription: string,
    existingTypes: ExistingType[],
  ): Promise<DeduplicationResult> {
    if (existingTypes.length === 0) {
      return { isDuplicate: false, matches: [] };
    }

    // Exact match check first (normalized)
    const normProposed = normalizeTypeName(proposedType);
    const exactMatch = existingTypes.find((t) => normalizeTypeName(t.type) === normProposed);
    if (exactMatch) {
      return {
        isDuplicate: true,
        matches: [{ type: exactMatch.type, description: exactMatch.description, similarity: 1.0 }],
      };
    }

    // Try embedding-based similarity if available
    if (this.embeddingProvider) {
      return this.checkWithEmbeddings(proposedType, proposedDescription, existingTypes);
    }

    // Fall back to Jaro-Winkler on type names
    return this.checkWithStringSimilarity(proposedType, existingTypes);
  }

  private async checkWithEmbeddings(
    proposedType: string,
    proposedDescription: string,
    existingTypes: ExistingType[],
  ): Promise<DeduplicationResult> {
    const proposedText = `${proposedType}: ${proposedDescription}`;
    const existingTexts = existingTypes.map((t) => `${t.type}: ${t.description}`);

    const allTexts = [proposedText, ...existingTexts];
    const embeddings = await this.embeddingProvider!.embedBatch(allTexts);
    const proposedEmbedding = embeddings[0]!;

    const matches: DeduplicationMatch[] = [];

    for (let i = 0; i < existingTypes.length; i++) {
      const similarity = this.cosineSimilarity(proposedEmbedding, embeddings[i + 1]!);
      if (similarity >= this.threshold) {
        matches.push({
          type: existingTypes[i]!.type,
          description: existingTypes[i]!.description,
          similarity,
        });
      }
    }

    // Sort by similarity descending
    matches.sort((a, b) => b.similarity - a.similarity);

    return {
      isDuplicate: matches.length > 0,
      matches,
    };
  }

  private checkWithStringSimilarity(
    proposedType: string,
    existingTypes: ExistingType[],
  ): DeduplicationResult {
    const normProposed = normalizeTypeName(proposedType);
    const matches: DeduplicationMatch[] = [];

    for (const existing of existingTypes) {
      const normExisting = normalizeTypeName(existing.type);
      const similarity = jaroWinklerSimilarity(normProposed, normExisting);

      if (similarity >= this.threshold) {
        matches.push({
          type: existing.type,
          description: existing.description,
          similarity,
        });
      }
    }

    // Sort by similarity descending
    matches.sort((a, b) => b.similarity - a.similarity);

    return {
      isDuplicate: matches.length > 0,
      matches,
    };
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    // Use provider's similarity function if available
    if (this.embeddingProvider?.similarity) {
      return this.embeddingProvider.similarity(a, b);
    }

    // Default cosine similarity
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }
}
