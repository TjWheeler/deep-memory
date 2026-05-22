import type { ILogger } from '../interfaces/ILogger.js';
import type { IMcpTool } from '../interfaces/IMcpTool.js';

import { InitTool } from '../tools/InitTool.js';
import { AnalyzeTool } from '../tools/AnalyzeTool.js';
import { DiagnoseTool } from '../tools/DiagnoseTool.js';
import { ExecuteTool } from '../tools/ExecuteTool.js';
import { StatusTool } from '../tools/StatusTool.js';
import { UpdateTool } from '../tools/UpdateTool.js';
import { StopTool } from '../tools/StopTool.js';
import { GettingStartedTool } from '../tools/GettingStartedTool.js';
import { PhaseGuidanceTool } from '../tools/PhaseGuidanceTool.js';

export interface ToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class ToolRegistry {
  private tools: Map<string, IMcpTool> = new Map();

  constructor(
    private logger: ILogger,
  ) {
    this.registerTools();
  }

  private registerTools(): void {
    this.register(new GettingStartedTool(this.logger));
    this.register(new PhaseGuidanceTool(this.logger));
    this.register(new InitTool(this.logger));
    this.register(new AnalyzeTool(this.logger));
    this.register(new DiagnoseTool(this.logger));
    this.register(new ExecuteTool(this.logger));
    this.register(new StatusTool(this.logger));
    this.register(new UpdateTool(this.logger));
    this.register(new StopTool(this.logger));

    this.logger.info('ToolRegistry', `Registered ${this.tools.size} tools`);
  }

  private register(tool: IMcpTool): void {
    if (this.tools.has(tool.name)) {
      this.logger.warn('ToolRegistry', `Tool ${tool.name} already registered, overwriting`);
    }
    this.tools.set(tool.name, tool);
  }

  listTools(): ToolInfo[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async executeTool(name: string, params: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool '${name}' not found`);
    }

    this.logger.debug('ToolRegistry', `Executing tool: ${name}`);

    try {
      const result = await tool.execute(params);
      this.logger.debug('ToolRegistry', `Tool ${name} completed`);
      return result;
    } catch (error) {
      this.logger.error('ToolRegistry', `Tool ${name} failed`, error);
      throw error;
    }
  }

  getToolCount(): number {
    return this.tools.size;
  }
}
