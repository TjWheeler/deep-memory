import type { IMcpTool } from '../../interfaces/IMcpTool.js';
import type { ILogger } from '../../interfaces/ILogger.js';

export abstract class BaseToolController implements IMcpTool {
  constructor(
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
}
