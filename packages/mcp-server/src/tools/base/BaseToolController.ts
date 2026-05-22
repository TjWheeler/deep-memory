import type { IMcpTool } from '../../interfaces/IMcpTool.js';
import type { ILogger } from '../../interfaces/ILogger.js';
import type { DeepMemory, MemoryRepository } from '@utaba/deep-memory';
import type { StorageProvider } from '@utaba/deep-memory/providers';
import { isValidUuid, EntityNotFoundError } from '@utaba/deep-memory';

export interface ToolContext {
  deepMemory: DeepMemory;
  storage: StorageProvider;
  getRepository: (repositoryId: string) => Promise<MemoryRepository>;
  evictRepository: (repositoryId: string) => void;
  /** Absolute or relative path where export zip files are written */
  exportDir: string;
}

export abstract class BaseToolController implements IMcpTool {
  constructor(
    protected context: ToolContext,
    protected logger: ILogger,
  ) {}

  abstract get name(): string;
  abstract get description(): string;
  abstract get inputSchema(): Record<string, unknown>;

  async execute(params: Record<string, unknown>): Promise<unknown> {
    try {
      this.validateParams(params);
      return await this.handleExecute(params);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(this.name, `Execution failed: ${message}`);
      throw error;
    }
  }

  protected abstract handleExecute(params: Record<string, unknown>): Promise<unknown>;

  protected validateParams(params: Record<string, unknown>): void {
    const schema = this.inputSchema;
    const required = schema['required'] as string[] | undefined;
    if (required) {
      for (const field of required) {
        if (params[field] === undefined || params[field] === null) {
          throw new Error(`Required parameter '${field}' is missing`);
        }
      }
    }
  }

  /**
   * Resolve an entity identifier that may be either a GUID or a slug.
   * Returns the GUID.
   */
  protected async resolveEntityId(repo: MemoryRepository, entityIdOrSlug: string): Promise<string> {
    if (isValidUuid(entityIdOrSlug)) {
      return entityIdOrSlug;
    }
    // Treat as slug — resolve to GUID
    const entity = await repo.getBySlug(entityIdOrSlug);
    if (!entity) {
      throw new EntityNotFoundError(entityIdOrSlug);
    }
    return entity.id;
  }
}
