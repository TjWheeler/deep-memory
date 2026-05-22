import { BaseToolController } from './base/BaseToolController.js';
import { StateManager } from '@utaba/deep-memory-indexer';
import type { EmbeddingProgress } from '@utaba/deep-memory-indexer';
import { resolveStateDir } from './resolveProcess.js';

export class StopTool extends BaseToolController {
  get name() { return 'indexing_stop'; }
  get description() { return 'Stop a running indexing pipeline. Writes a stop signal that workers check between operations (extraction batches, embedding batches, validation batches). Resets any sources stuck in "extracting" back to "pending".'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        processDir: { type: 'string', description: 'Path to the indexing process directory (contains config.json).' },
        stateDir: { type: 'string', description: 'Use only for standalone state directories not inside a processDir. When processDir is provided, stateDir is resolved automatically to processDir/state/.' },
        reason: { type: 'string', description: 'Reason for stopping (optional, logged in the stop signal).' },
      },
      required: ['processDir'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const stateDir = resolveStateDir(params);
    const reason = params['reason'] as string | undefined;
    const state = new StateManager(stateDir);

    await state.requestStop(reason);
    const resetCount = await state.resetExtractingSources();
    await state.releaseProcessLock();

    const embeddingProgress = await state.getEmbeddingProgress<EmbeddingProgress>();
    const embeddingRunning = embeddingProgress?.status === 'running';

    return {
      message: `Stop requested. ${resetCount} source(s) reset from "extracting" to "pending".${embeddingRunning ? ' Embedding will stop after the current batch completes.' : ''}`,
      resetCount,
      embeddingRunning,
      reason: reason ?? 'Stop requested',
    };
  }
}
