// Provider-agnostic operation usage — for billing, rate limiting, and telemetry.
//
// Every provider (storage, embeddings, LLM) can emit an OperationUsage record
// per public API call, describing what it cost. Callers pass a UsageSink at
// provider-construction time to receive these records. The sink runs in the
// caller's process and is never surfaced to AI agents — MCP servers and other
// hosts deliberately avoid plumbing the sink through to model-visible
// responses.

/**
 * Cost/usage record for a single public provider operation.
 *
 * Emitted once per top-level call (e.g. `createEntity`, `findEntities`,
 * `traverse`, `embedBatch`, `chatCompletion`). If the operation internally
 * issues multiple database round-trips, the provider aggregates their costs
 * into a single record.
 */
export interface OperationUsage {
  /**
   * Provider identifier. Canonical values used by the built-in providers:
   * `'cosmosdb'`, `'sqlserver'`, `'openai'`, `'anthropic'`.
   * Custom providers should use their own stable identifier.
   */
  provider: string;

  /**
   * Name of the public provider method that produced this usage, e.g.
   * `'createEntity'`, `'findEntities'`, `'traverse'`, `'embedBatch'`,
   * `'chatCompletion'`.
   */
  operation: string;

  /**
   * Unit of the `value` field. Canonical values:
   *   `'RU'`       — CosmosDB request units
   *   `'ms'`       — wall-clock execution time (SQL Server, generic)
   *   `'tokens'`   — total tokens (embeddings, LLM completions)
   */
  unit: string;

  /** Magnitude of the cost in the stated unit. Always non-negative. */
  value: number;

  /**
   * Repository the operation was scoped to, if applicable. Absent for
   * cross-repository operations (e.g. `listRepositories`) and for providers
   * that operate outside a repository context (e.g. the embeddings provider
   * during indexer extraction, before the data is imported into a repo).
   */
  repositoryId?: string;

  /** When the operation completed. */
  timestamp: Date;

  /**
   * Optional provider-specific breakdown. Examples:
   *   CosmosDB: `{ calls: 3, retries: 0 }`
   *   LLM:      `{ inputTokens: 1200, outputTokens: 340, cacheReadTokens: 800 }`
   */
  details?: Record<string, number>;
}

/**
 * Callback that receives usage records. Providers invoke this once per public
 * operation when configured. The sink must not throw — providers wrap it
 * defensively, but a well-behaved implementation swallows its own errors.
 */
export type UsageSink = (usage: OperationUsage) => void;
