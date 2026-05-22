import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ILogger } from '../interfaces/ILogger.js';
import { ToolRegistry } from './ToolRegistry.js';
import { McpHandler } from './McpHandler.js';

export class McpServer {
  private server: Server;
  private handler: McpHandler;

  constructor(
    private logger: ILogger,
  ) {
    const toolRegistry = new ToolRegistry(this.logger);
    this.handler = new McpHandler(toolRegistry, this.logger);

    this.server = new Server(
      {
        name: '@utaba/deep-memory-indexer-mcp-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, this.handler.handleToolsList.bind(this.handler));
    this.server.setRequestHandler(CallToolRequestSchema, this.handler.handleToolCall.bind(this.handler));
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.logger.info('McpServer', 'Deep Memory Indexer MCP server started on stdio');
  }

  async stop(): Promise<void> {
    await this.server.close();
    this.logger.info('McpServer', 'Deep Memory Indexer MCP server stopped');
  }
}
