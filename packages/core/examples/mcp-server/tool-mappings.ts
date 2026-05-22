/**
 * MCP Tool Mappings — shows how to map Deep Memory functions to MCP tool definitions.
 *
 * This demonstrates the "functions, not tools" philosophy:
 * Deep Memory provides domain functions; you define the tool interface
 * that suits your AI platform.
 *
 * To use: install @modelcontextprotocol/sdk and wire these into an MCP server.
 */

import type { MemoryRepository } from '@utaba/deep-memory';

// ─── MCP Tool Definitions ──────────────────────────────────────────
// These would be registered with your MCP server's tool list.

export const TOOL_DEFINITIONS = [
  {
    name: 'memory_create_entity',
    description: 'Create a new entity in the knowledge graph',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entityType: { type: 'string', description: 'Entity type (must exist in vocabulary)' },
        label: { type: 'string', description: 'Human-readable label' },
        summary: { type: 'string', description: 'Brief description' },
        properties: { type: 'object', description: 'Typed properties per vocabulary schema' },
      },
      required: ['entityType', 'label'],
    },
  },
  {
    name: 'memory_update_entity',
    description: 'Update an existing entity',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entityId: { type: 'string' },
        label: { type: 'string' },
        summary: { type: 'string' },
        properties: { type: 'object' },
      },
      required: ['entityId'],
    },
  },
  {
    name: 'memory_find_entities',
    description: 'Search for entities by label, type, or properties',
    inputSchema: {
      type: 'object' as const,
      properties: {
        searchTerm: { type: 'string', description: 'Search term to match against labels' },
        entityTypes: { type: 'array', items: { type: 'string' }, description: 'Filter by type' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
    },
  },
  {
    name: 'memory_create_relationship',
    description: 'Create a relationship between two entities',
    inputSchema: {
      type: 'object' as const,
      properties: {
        relationshipType: { type: 'string' },
        sourceEntityId: { type: 'string' },
        targetEntityId: { type: 'string' },
        properties: { type: 'object' },
      },
      required: ['relationshipType', 'sourceEntityId', 'targetEntityId'],
    },
  },
  {
    name: 'memory_explore',
    description: 'Explore the neighborhood of an entity',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entityId: { type: 'string' },
        depth: { type: 'number', description: '1, 2, or 3 (default 1)' },
        relationshipTypes: { type: 'array', items: { type: 'string' } },
      },
      required: ['entityId'],
    },
  },
  {
    name: 'memory_get_vocabulary',
    description: 'Get the vocabulary (available entity and relationship types)',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

// ─── Tool Handler ──────────────────────────────────────────────────
// Route MCP tool calls to Deep Memory functions.

export async function handleToolCall(
  repo: MemoryRepository,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (toolName) {
    case 'memory_create_entity':
      return repo.createEntities([{
        entityType: args.entityType as string,
        label: args.label as string,
        summary: args.summary as string | undefined,
        properties: args.properties as Record<string, unknown> | undefined,
      }]);

    case 'memory_update_entity':
      return repo.updateEntity(args.entityId as string, {
        label: args.label as string | undefined,
        summary: args.summary as string | undefined,
        properties: args.properties as Record<string, unknown> | undefined,
      });

    case 'memory_find_entities':
      return repo.findEntities({
        searchTerm: args.searchTerm as string | undefined,
        entityTypes: args.entityTypes as string[] | undefined,
        limit: args.limit as number | undefined,
      });

    case 'memory_create_relationship':
      return repo.createRelationships([{
        relationshipType: args.relationshipType as string,
        sourceEntityId: args.sourceEntityId as string,
        targetEntityId: args.targetEntityId as string,
        properties: args.properties as Record<string, unknown> | undefined,
      }]);

    case 'memory_explore':
      return repo.exploreNeighborhood(args.entityId as string, {
        depth: (args.depth as 1 | 2 | 3) ?? 1,
        relationshipTypes: args.relationshipTypes as string[] | undefined,
      });

    case 'memory_get_vocabulary':
      return repo.getVocabulary();

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
