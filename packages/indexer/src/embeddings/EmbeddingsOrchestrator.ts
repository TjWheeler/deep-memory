import type { EmbeddingsConfig, EmbeddingsWorkerConfig } from '../types/config.js';
import { StateManager, Phase } from '../orchestrator/StateManager.js';

/** Per-worker stats for multi-worker progress tracking */
export interface EmbeddingWorkerStats {
  name: string;
  model: string;
  endpoint: string;
  processed: number;
  failed: number;
  completedBatches: number;
  totalBatches: number;
  totalTokens: number;
  estimatedCostUsd: number;
  status: 'running' | 'complete' | 'failed';
  lastError?: string;
}

/** Progress state persisted to disk between batches */
export interface EmbeddingProgress {
  status: 'running' | 'stopped' | 'complete' | 'failed';
  totalEntities: number;
  processed: number;
  failed: number;
  totalBatches: number;
  completedBatches: number;
  startedAt: string;
  lastBatchAt?: string;
  elapsedMs: number;
  estimatedRemainingMs?: number;
  model: string;
  endpoint: string;
  dimensions?: number;
  errors?: Array<{ entityId: string; error: string }>;
  stoppedReason?: string;
  workerStats?: EmbeddingWorkerStats[];
}

/** Minimal entity data needed for embedding */
export interface EmbeddingEntity {
  id: string;
  label: string;
  summary?: string;
}

/**
 * Result from the entity loader. The orchestrator does its own work-splitting
 * from `EmbeddingsDependencies.totalEntities`, so the page doesn't need to
 * report a total — it just delivers a contiguous slice of entities.
 */
export interface EmbeddingEntityPage {
  items: EmbeddingEntity[];
}

/** Response shape from the OpenAI /v1/embeddings endpoint */
interface EmbeddingsApiResponse {
  data: Array<{ index: number; embedding: number[] }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

/**
 * Dependencies injected by the MCP tool.
 */
export interface EmbeddingsDependencies {
  loadEntities: (limit: number, offset: number) => Promise<EmbeddingEntityPage>;
  saveVector: (entityId: string, vector: number[]) => Promise<void>;
  totalEntities: number;
}

/** Resolved worker config with all defaults filled in */
interface ResolvedWorker {
  name: string;
  endpoint: string;
  model: string;
  apiKey?: string;
  batchSize: number;
  concurrency: number;
  delayMs: number;
  maxRetries: number;
  costPerMillionTokens: number;
  weight: number;
  startOffset: number;
  entityCount: number;
}

/**
 * Orchestrates the embedding phase (Phase E) with progress tracking,
 * stop signal support, and optional multi-worker parallelism.
 *
 * Single-worker mode: top-level endpoint/model in config.
 * Multi-worker mode: config.workers array — entities split by range,
 * workers run concurrently with per-worker concurrency limits.
 */
export class EmbeddingsOrchestrator {
  constructor(
    private readonly config: EmbeddingsConfig,
    private readonly state: StateManager,
  ) {}

  async run(deps: EmbeddingsDependencies): Promise<EmbeddingProgress> {
    await this.state.clearStopRequest();

    const workers = this.resolveWorkers(deps.totalEntities);
    const totalBatches = workers.reduce((s, w) => s + Math.ceil(w.entityCount / w.batchSize), 0);
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    const progress: EmbeddingProgress = {
      status: 'running',
      totalEntities: deps.totalEntities,
      processed: 0,
      failed: 0,
      totalBatches,
      completedBatches: 0,
      startedAt,
      elapsedMs: 0,
      model: workers.length === 1 ? workers[0]!.model : workers.map(w => w.name).join(', '),
      endpoint: workers.length === 1 ? workers[0]!.endpoint : `${workers.length} workers`,
    };

    if (workers.length > 1) {
      progress.workerStats = workers.map(w => ({
        name: w.name,
        model: w.model,
        endpoint: w.endpoint,
        processed: 0,
        failed: 0,
        completedBatches: 0,
        totalBatches: Math.ceil(w.entityCount / w.batchSize),
        totalTokens: 0,
        estimatedCostUsd: 0,
        status: 'running' as const,
      }));
    }

    await this.state.setPipelineState(Phase.EMBEDDINGS);
    await this.state.saveEmbeddingProgress(progress);

    const allErrors: Array<{ entityId: string; error: string }> = [];
    let aborted = false;

    // Callback for workers to report batch completion
    const onBatchComplete = async (
      workerIndex: number,
      stats: { processed: number; failed: number; tokens: number; errors: Array<{ entityId: string; error: string }> },
    ) => {
      progress.processed += stats.processed;
      progress.failed += stats.errors.length;
      progress.completedBatches++;
      allErrors.push(...stats.errors);

      if (progress.workerStats && progress.workerStats[workerIndex]) {
        const ws = progress.workerStats[workerIndex];
        ws.processed += stats.processed;
        ws.failed += stats.errors.length;
        ws.completedBatches++;
        ws.totalTokens += stats.tokens;
        const w = workers[workerIndex]!;
        ws.estimatedCostUsd = (ws.totalTokens / 1_000_000) * w.costPerMillionTokens;
        if (stats.errors.length > 0) {
          ws.lastError = stats.errors[stats.errors.length - 1]?.error;
        }
      }

      const now = Date.now();
      progress.elapsedMs = now - startMs;
      progress.lastBatchAt = new Date(now).toISOString();
      if (progress.completedBatches > 0) {
        const avgBatchMs = progress.elapsedMs / progress.completedBatches;
        const remaining = totalBatches - progress.completedBatches;
        progress.estimatedRemainingMs = remaining > 0 ? Math.round(avgBatchMs * remaining) : 0;
      }

      await this.state.saveEmbeddingProgress(progress);

      // Check global error threshold
      const errorThreshold = this.config.errorThresholdToAbort;
      if (errorThreshold !== undefined && progress.failed >= errorThreshold) {
        aborted = true;
      }
    };

    // Run all workers concurrently
    const workerPromises = workers.map((w, idx) =>
      this.runWorkerRange(w, idx, deps, onBatchComplete, () => aborted, progress),
    );
    await Promise.all(workerPromises);

    // Finalize
    progress.elapsedMs = Date.now() - startMs;
    if (allErrors.length > 0) {
      progress.errors = allErrors.slice(0, 20);
    }

    // Mark worker final statuses
    if (progress.workerStats) {
      for (const ws of progress.workerStats) {
        if (ws.status === 'running') {
          ws.status = ws.failed > 0 && ws.processed === 0 ? 'failed' : 'complete';
        }
      }
    }

    if (progress.status === 'running') {
      if (aborted) {
        progress.status = 'failed';
        progress.stoppedReason = `Error threshold reached: ${progress.failed} failures`;
      } else if (progress.failed > 0 && progress.processed === 0) {
        progress.status = 'failed';
        progress.stoppedReason = `All batches failed (${progress.failed} failures)`;
      } else {
        progress.status = 'complete';
        await this.state.setPipelineState(Phase.COMPLETE);
      }
    }

    await this.state.saveEmbeddingProgress(progress);
    return progress;
  }

  /** Run a single worker over its assigned entity range */
  private async runWorkerRange(
    worker: ResolvedWorker,
    workerIndex: number,
    deps: EmbeddingsDependencies,
    onBatchComplete: (workerIndex: number, stats: { processed: number; failed: number; tokens: number; errors: Array<{ entityId: string; error: string }> }) => Promise<void>,
    isAborted: () => boolean,
    progress: EmbeddingProgress,
  ): Promise<void> {
    if (worker.entityCount === 0) return;

    const { batchSize, concurrency, delayMs, maxRetries } = worker;
    let nextOffset = worker.startOffset;
    const endOffset = worker.startOffset + worker.entityCount;

    const runLane = async (): Promise<void> => {
      while (nextOffset < endOffset) {
        // Check stop signal and abort flag
        if (isAborted() || await this.state.isStopRequested()) {
          if (progress.status === 'running') {
            progress.status = 'stopped';
            progress.stoppedReason = 'Stop signal received';
          }
          return;
        }

        const currentOffset = nextOffset;
        const remaining = endOffset - currentOffset;
        const currentBatch = Math.min(batchSize, remaining);
        nextOffset += currentBatch;

        // Load entities
        const page = await deps.loadEntities(currentBatch, currentOffset);
        if (page.items.length === 0) return;

        // Call embeddings API with retry
        const texts = page.items.map(e => [e.label, e.summary ?? ''].join(' '));
        let vectors: number[][] | null = null;
        let lastError = '';
        let apiTokens = 0;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            const response = await this.callEmbeddingsApi(texts, worker.endpoint, worker.model, worker.apiKey);
            vectors = response.data
              .sort((a, b) => a.index - b.index)
              .map(d => d.embedding);
            apiTokens = response.usage?.prompt_tokens ?? 0;
            if (vectors.length > 0 && vectors[0] && !progress.dimensions) {
              progress.dimensions = vectors[0].length;
            }
            break;
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            if (attempt < maxRetries) {
              const backoffMs = 1000 * (2 ** attempt);
              await new Promise<void>(resolve => { setTimeout(resolve, backoffMs); });
            }
          }
        }

        const batchErrors: Array<{ entityId: string; error: string }> = [];
        let batchProcessed = 0;

        if (!vectors) {
          for (const ent of page.items) {
            batchErrors.push({ entityId: ent.id, error: `embedBatch failed after ${maxRetries} retries: ${lastError}` });
          }
        } else {
          for (let i = 0; i < page.items.length; i++) {
            const ent = page.items[i]!;
            const vector = vectors[i];
            if (!vector) {
              batchErrors.push({ entityId: ent.id, error: 'No vector returned for entity' });
              continue;
            }
            try {
              await deps.saveVector(ent.id, vector);
              batchProcessed++;
            } catch (err) {
              batchErrors.push({ entityId: ent.id, error: err instanceof Error ? err.message : String(err) });
            }
          }
        }

        await onBatchComplete(workerIndex, {
          processed: batchProcessed,
          failed: batchErrors.length,
          tokens: apiTokens,
          errors: batchErrors,
        });

        // Rate limiting delay
        if (delayMs > 0 && nextOffset < endOffset) {
          await new Promise<void>(resolve => { setTimeout(resolve, delayMs); });
        }
      }
    };

    // Run concurrent lanes within this worker
    const lanes = Array.from(
      { length: Math.min(concurrency, Math.ceil(worker.entityCount / batchSize)) },
      () => runLane(),
    );
    await Promise.all(lanes);
  }

  /** Resolve config into worker array with ranges assigned */
  private resolveWorkers(totalEntities: number): ResolvedWorker[] {
    if (this.config.workers && this.config.workers.length > 0) {
      return this.resolveMultiWorkers(this.config.workers, totalEntities);
    }

    // Single worker from top-level config
    return [{
      name: 'default',
      endpoint: this.config.endpoint,
      model: this.config.model,
      apiKey: this.config.apiKey,
      batchSize: Math.min(this.config.batchSize ?? 50, 200),
      concurrency: 1,
      delayMs: this.config.delayBetweenBatchesMs ?? 0,
      maxRetries: this.config.maxRetries ?? 3,
      costPerMillionTokens: this.config.costPerMillionTokens ?? 0,
      weight: 1,
      startOffset: 0,
      entityCount: totalEntities,
    }];
  }

  private resolveMultiWorkers(configs: EmbeddingsWorkerConfig[], totalEntities: number): ResolvedWorker[] {
    const totalWeight = configs.reduce((s, w) => s + (w.weight ?? 1), 0);
    const workers: ResolvedWorker[] = [];
    let offset = 0;
    let remaining = totalEntities;

    for (let i = 0; i < configs.length; i++) {
      const wc = configs[i]!;
      const weight = wc.weight ?? 1;
      const isLast = i === configs.length - 1;
      const entityCount = isLast ? remaining : Math.round(totalEntities * (weight / totalWeight));

      workers.push({
        name: wc.name,
        endpoint: wc.endpoint,
        model: wc.model,
        apiKey: wc.apiKey,
        batchSize: Math.min(wc.batchSize ?? 50, 200),
        concurrency: wc.concurrency ?? 1,
        delayMs: wc.delayBetweenBatchesMs ?? 0,
        maxRetries: wc.maxRetries ?? 3,
        costPerMillionTokens: wc.costPerMillionTokens ?? 0,
        weight,
        startOffset: offset,
        entityCount,
      });

      offset += entityCount;
      remaining -= entityCount;
    }

    return workers;
  }

  private async callEmbeddingsApi(
    texts: string[],
    endpoint: string,
    model: string,
    apiKey?: string,
  ): Promise<EmbeddingsApiResponse> {
    let url = endpoint.replace(/\/+$/, '');
    if (!url.endsWith('/v1')) {
      url += '/v1';
    }
    url += '/embeddings';

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: texts, model }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Embeddings API ${response.status}: ${body}`);
    }

    return (await response.json()) as EmbeddingsApiResponse;
  }
}
