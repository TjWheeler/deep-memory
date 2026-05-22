import { McpServer } from './server/McpServer.js';
import { ConsoleLogger } from './interfaces/ILogger.js';

const logger = new ConsoleLogger();

const server = new McpServer(logger);

process.on('SIGINT', async () => {
  await server.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await server.stop();
  process.exit(0);
});

server.start().catch((error) => {
  logger.error('main', 'Failed to start Indexer MCP server', error);
  process.exit(1);
});
