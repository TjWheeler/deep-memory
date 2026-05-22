import { BaseToolController } from '../base/BaseToolController.js';

export class ReembedRepositoryTool extends BaseToolController {
  get name() { return 'memory_reembed_repository'; }
  get description() {
    return 'Re-embed all entities in a repository. Optionally switch to a different embedding model or dimensionality — the repository metadata is updated first so subsequent writes use the new configuration. Retries failed batches with exponential backoff. Aborts early if error threshold is reached.';
  }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository to re-embed' },
        model: { type: 'string', description: 'New embedding model identifier to switch the repository to (e.g. "Qwen/Qwen3-Embedding-8B"). Omit to keep the current model.' },
        dimensions: { type: 'number', description: 'New embedding dimensionality to switch the repository to (e.g. 1024). Omit to keep the current dimensionality.' },
        batchSize: { type: 'number', description: 'Entities per batch (default 50, max 200)' },
        maxRetries: { type: 'number', description: 'Retries per batch on embedding API failure with exponential backoff (default 3)' },
        errorThresholdToAbort: { type: 'number', description: 'Abort after this many cumulative failures. Omit for no limit.' },
        delayBetweenBatchesMs: { type: 'number', description: 'Milliseconds to wait between batches for rate limiting (default 0)' },
      },
      required: ['repositoryId'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repositoryId = params['repositoryId'] as string;
    const batchSize = Math.min((params['batchSize'] as number | undefined) ?? 50, 200);

    const result = await this.context.deepMemory.reembedAll(repositoryId, {
      model: params['model'] as string | undefined,
      dimensions: params['dimensions'] as number | undefined,
      batchSize,
      maxRetries: params['maxRetries'] as number | undefined,
      errorThresholdToAbort: params['errorThresholdToAbort'] as number | undefined,
      delayBetweenBatchesMs: params['delayBetweenBatchesMs'] as number | undefined,
    });

    return {
      processed: result.processed,
      failed: result.failed,
      errors: result.errors,
      modelId: result.modelId,
      dimensions: result.dimensions,
    };
  }
}
