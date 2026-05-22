import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  DeepMemory,
  InMemoryStorageProvider,
  InMemorySearchProvider,
  type MemoryRepository,
  type StorageProvider,
  type GraphTraversalProvider,
} from '@utaba/deep-memory';
import { OpenAIEmbeddingProvider } from '@utaba/deep-memory-embeddings-openai';
import { SqlServerStorageProvider } from '@utaba/deep-memory-storage-sqlserver';
import { CosmosDbProvider } from '@utaba/deep-memory-storage-cosmosdb';
import type { ILogger } from '../interfaces/ILogger.js';
import { ToolRegistry } from './ToolRegistry.js';
import { McpHandler } from './McpHandler.js';
import type { ToolContext } from '../tools/base/BaseToolController.js';

export interface McpServerConfig {
  /** Actor ID for provenance tracking (default: 'mcp-agent') */
  actorId?: string;
  /** Actor type for provenance (default: 'agent') */
  actorType?: string;
  /** Embeddings API base URL (e.g. 'http://localhost:8010'). Enables semantic search when set. */
  embeddingsBaseUrl?: string;
  /** Default embeddings model for newly created repositories. Each repo stores its own model in metadata. */
  embeddingsModel?: string;
  /** Default embeddings dimensionality for newly created repositories. Each repo stores its own dimensions in metadata. */
  embeddingsDimensions?: number;
  /** Embeddings API key (optional, not needed for local servers) */
  embeddingsApiKey?: string;
  /** Storage type: 'memory' (default), 'sqlserver', or 'cosmosdb' */
  storageType?: 'memory' | 'sqlserver' | 'cosmosdb';
  /** SQL Server host (required when storageType is 'sqlserver') */
  sqlServerHost?: string;
  /** SQL Server port (default: 1433) */
  sqlServerPort?: number;
  /** SQL Server database name */
  sqlServerDatabase?: string;
  /** SQL Server username */
  sqlServerUser?: string;
  /** SQL Server password */
  sqlServerPassword?: string;
  /** SQL Server schema (default: 'dbo') */
  sqlServerSchema?: string;
  /** Trust server certificate for SQL Server (default: false) */
  sqlServerTrustCert?: boolean;
  /** CosmosDB Gremlin WebSocket endpoint (required when storageType is 'cosmosdb') */
  cosmosDbEndpoint?: string;
  /** CosmosDB REST endpoint — derived from Gremlin endpoint if omitted */
  cosmosDbRestEndpoint?: string;
  /** CosmosDB primary key */
  cosmosDbKey?: string;
  /** CosmosDB database name */
  cosmosDbDatabase?: string;
  /** CosmosDB container (graph) name */
  cosmosDbContainer?: string;
  /** Reject unauthorized TLS certs — set false for emulator (default: true) */
  cosmosDbRejectUnauthorized?: boolean;
  /** Directory where exported zip files are written (default: './exports') */
  exportDir?: string;
}

export class McpServer {
  private server: Server;
  private handler: McpHandler;
  private deepMemory: DeepMemory;
  private repositories: Map<string, MemoryRepository> = new Map();

  constructor(
    config: McpServerConfig,
    private logger: ILogger,
  ) {
    let storage: StorageProvider;
    let graphTraversal: GraphTraversalProvider | undefined;
    if (config.storageType === 'sqlserver') {
      storage = new SqlServerStorageProvider({
        connection: {
          server: config.sqlServerHost!,
          port: config.sqlServerPort ?? 1433,
          database: config.sqlServerDatabase!,
          user: config.sqlServerUser,
          password: config.sqlServerPassword,
          options: {
            encrypt: false,
            trustServerCertificate: config.sqlServerTrustCert ?? false,
          },
        },
        schema: config.sqlServerSchema ?? 'dbo',
      });
    } else if (config.storageType === 'cosmosdb') {
      const cosmos = new CosmosDbProvider({
        endpoint: config.cosmosDbEndpoint!,
        restEndpoint: config.cosmosDbRestEndpoint,
        key: config.cosmosDbKey!,
        database: config.cosmosDbDatabase!,
        container: config.cosmosDbContainer!,
        rejectUnauthorized: config.cosmosDbRejectUnauthorized ?? true,
      });
      storage = cosmos;
      graphTraversal = cosmos;
    } else {
      storage = new InMemoryStorageProvider();
    }

    const search = config.storageType === 'memory' || !config.storageType ? new InMemorySearchProvider() : undefined;

    // Build a factory — model + dimensions come from the repository's stored metadata
    // at open time, so repositories with different embedding configurations can coexist
    // against the same embeddings endpoint.
    const embeddingFactory = config.embeddingsBaseUrl
      ? ({ model, dimensions }: { model: string; dimensions: number }) =>
          new OpenAIEmbeddingProvider({
            baseUrl: config.embeddingsBaseUrl!,
            model,
            dimensions,
            apiKey: config.embeddingsApiKey,
          })
      : undefined;

    this.deepMemory = new DeepMemory({
      storage,
      search,
      embeddingFactory,
      defaultEmbeddingModel: config.embeddingsModel,
      defaultEmbeddingDimensions: config.embeddingsDimensions,
      graphTraversal,
      provenance: {
        actorId: config.actorId ?? 'mcp-agent',
        actorType: (config.actorType ?? 'agent') as 'agent' | 'user',
      },
    });

    const toolContext: ToolContext = {
      deepMemory: this.deepMemory,
      storage,
      getRepository: this.getRepository.bind(this),
      evictRepository: this.evictRepository.bind(this),
      exportDir: config.exportDir ?? './exports',
    };

    const toolRegistry = new ToolRegistry(toolContext, this.logger);
    this.handler = new McpHandler(toolRegistry, this.logger);

    this.server = new Server(
      {
        name: '@utaba/deep-memory-local-mcp-server',
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

  private async getRepository(repositoryId: string): Promise<MemoryRepository> {
    let repo = this.repositories.get(repositoryId);
    if (!repo) {
      repo = await this.deepMemory.openRepository(repositoryId);
      this.repositories.set(repositoryId, repo);
    }
    return repo;
  }

  private evictRepository(repositoryId: string): void {
    this.repositories.delete(repositoryId);
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.logger.info('McpServer', 'Deep Memory MCP server started on stdio');
    // Schema check is best-effort and must not block the transport handshake.
    // Tools that need storage will fail individually with a clear error at call time.
    this.deepMemory.ensureSchema().catch((error: unknown) => {
      this.logger.warn('McpServer', `Storage unavailable on startup — repository tools will fail until storage is reachable: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async stop(): Promise<void> {
    this.repositories.clear();
    await this.deepMemory.dispose();
    await this.server.close();
    this.logger.info('McpServer', 'Deep Memory MCP server stopped');
  }
}
