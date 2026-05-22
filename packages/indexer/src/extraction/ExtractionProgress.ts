/**
 * Progress data for an active extraction, written to disk after each chunk.
 * Read by the status tool to surface real-time extraction progress.
 */
export interface ExtractionProgress {
  source: string;
  sourcePath: string;
  assignedWorker?: string;
  totalChunks: number;
  completedChunks: number;
  startedAt: string;
  lastChunkAt?: string;
  elapsedMs: number;
  avgChunkMs?: number;
  estimatedRemainingMs?: number;
  tokensUsed: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  entitiesSoFar: number;
  relationshipsSoFar: number;
  /** Rate limit throttle stats accumulated during this extraction */
  throttle?: {
    /** Total number of 429 retries across all chunks */
    totalRetries: number;
    /** Total time spent waiting for rate limit backoff (ms) */
    totalBackoffMs: number;
    /** Timestamp of the most recent throttle event */
    lastThrottledAt?: string;
  };
}

/** Callback type for extraction progress updates */
export type OnExtractionProgress = (progress: ExtractionProgress) => Promise<void>;

/** Checkpoint data persisted after each chunk for resume capability */
export interface ExtractionCheckpoint {
  source: string;
  sourcePath: string;
  model: string;
  chunkingStrategy: string;
  totalChunks: number;
  completedChunks: number;
  entities: import('../types/extraction.js').ExtractedEntity[];
  relationships: import('../types/extraction.js').ExtractedRelationship[];
  progressiveContext: import('./ProgressiveContext.js').ProgressiveContextSnapshot;
  tokensUsed: {
    inputTokens: number;
    outputTokens: number;
  };
  lastUpdated: string;
}
