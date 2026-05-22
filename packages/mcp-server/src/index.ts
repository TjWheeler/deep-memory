import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer } from './server/McpServer.js';
import { ConsoleLogger } from './interfaces/ILogger.js';

// Load .env.local from the current working directory (workspace root when launched by an MCP host).
// Values already present in process.env take precedence, so shell overrides still win.
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf8');
  for (const raw of content.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
loadEnvFile(resolve(process.cwd(), '.env.local'));

const logger = new ConsoleLogger();

const storageSetting = process.env['DEEP_MEMORY_STORAGE'];
const storageType = storageSetting === 'sqlserver' ? 'sqlserver' as const
  : storageSetting === 'cosmosdb' ? 'cosmosdb' as const
  : 'memory' as const;

const server = new McpServer(
  {
    actorId: process.env['DEEP_MEMORY_ACTOR_ID'] ?? 'mcp-agent',
    actorType: process.env['DEEP_MEMORY_ACTOR_TYPE'] ?? 'agent',
    embeddingsBaseUrl: process.env['DEEP_MEMORY_EMBEDDINGS_BASE_URL'],
    embeddingsModel: process.env['DEEP_MEMORY_EMBEDDINGS_MODEL'],
    embeddingsDimensions: process.env['DEEP_MEMORY_EMBEDDINGS_DIMENSIONS']
      ? Number(process.env['DEEP_MEMORY_EMBEDDINGS_DIMENSIONS'])
      : undefined,
    embeddingsApiKey: process.env['DEEP_MEMORY_EMBEDDINGS_API_KEY'],
    storageType,
    sqlServerHost: process.env['DEEP_MEMORY_SQL_HOST'],
    sqlServerPort: process.env['DEEP_MEMORY_SQL_PORT'] ? Number(process.env['DEEP_MEMORY_SQL_PORT']) : undefined,
    sqlServerDatabase: process.env['DEEP_MEMORY_SQL_DATABASE'],
    sqlServerUser: process.env['DEEP_MEMORY_SQL_USER'],
    sqlServerPassword: process.env['DEEP_MEMORY_SQL_PASSWORD'],
    sqlServerSchema: process.env['DEEP_MEMORY_SQL_SCHEMA'],
    sqlServerTrustCert: process.env['DEEP_MEMORY_SQL_TRUST_CERT'] === 'true',
    cosmosDbEndpoint: process.env['DEEP_MEMORY_COSMOSDB_ENDPOINT'],
    cosmosDbRestEndpoint: process.env['DEEP_MEMORY_COSMOSDB_REST_ENDPOINT'],
    cosmosDbKey: process.env['DEEP_MEMORY_COSMOSDB_KEY'],
    cosmosDbDatabase: process.env['DEEP_MEMORY_COSMOSDB_DATABASE'],
    cosmosDbContainer: process.env['DEEP_MEMORY_COSMOSDB_CONTAINER'],
    cosmosDbRejectUnauthorized: process.env['DEEP_MEMORY_COSMOSDB_REJECT_UNAUTHORIZED'] !== 'false',
    exportDir: process.env['DEEP_MEMORY_EXPORT_DIR'] ?? './exports',
  },
  logger,
);

// Graceful shutdown
process.on('SIGINT', async () => {
  await server.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await server.stop();
  process.exit(0);
});

server.start().catch((error) => {
  logger.error('main', 'Failed to start MCP server', error);
  process.exit(1);
});
