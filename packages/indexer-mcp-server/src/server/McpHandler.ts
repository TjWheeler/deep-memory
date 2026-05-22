import type { ILogger } from '../interfaces/ILogger.js';
import type { ToolRegistry } from './ToolRegistry.js';

export class McpHandler {
  constructor(
    private toolRegistry: ToolRegistry,
    private logger: ILogger,
  ) {}

  async handleToolsList(): Promise<{ tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }> {
    this.logger.debug('McpHandler', 'Received tools/list request');

    const tools = this.toolRegistry.listTools();
    this.logger.info('McpHandler', `Returning ${tools.length} tools`);

    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  }

  async handleToolCall(request: { params: { name: string; arguments?: Record<string, unknown> } }): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }> {
    const { name, arguments: args } = request.params;

    this.logger.debug('McpHandler', `Received tool call: ${name}`);

    try {
      if (!name) {
        throw new Error('Tool name is required');
      }

      const result = await this.toolRegistry.executeTool(name, args ?? {});

      this.logger.info('McpHandler', `Tool ${name} executed successfully`);

      // Pre-formatted MCP response passthrough
      if (result && typeof result === 'object' && 'content' in (result as Record<string, unknown>) && Array.isArray((result as Record<string, unknown>)['content'])) {
        return result as { content: Array<{ type: string; text: string }> };
      }

      // String results
      if (typeof result === 'string') {
        return { content: [{ type: 'text', text: result }] };
      }

      // Objects/arrays as JSON
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('McpHandler', `Tool ${name} failed: ${message}`);

      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  }
}
