import { BaseToolController } from '../base/BaseToolController.js';

export class EnsureSchemaTool extends BaseToolController {
  get name() { return 'memory_ensure_schema'; }
  get description() { return 'Ensure the storage provider schema exists (creates tables/indexes if needed). Idempotent — safe to call multiple times. Only relevant for persistent storage providers (e.g., SQL Server); no-op for in-memory storage.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {},
    };
  }

  protected async handleExecute(_params: Record<string, unknown>) {
    const result = await this.context.deepMemory.ensureSchema();
    return { success: true, ...result };
  }
}
