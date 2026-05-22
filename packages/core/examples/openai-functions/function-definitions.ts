/**
 * OpenAI Function Definitions — map Deep Memory operations to OpenAI function calling format.
 *
 * Pass these to the `tools` parameter of the Chat Completions API.
 * When the model calls a function, route it through handleFunctionCall().
 */

import type { MemoryRepository } from '@utaba/deep-memory';

// ─── OpenAI Function Definitions ───────────────────────────────────

export const FUNCTIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'memory_create_entity',
      description: 'Create a new entity in the knowledge graph. The entity type must exist in the vocabulary.',
      parameters: {
        type: 'object',
        properties: {
          entityType: { type: 'string', description: 'Entity type from the vocabulary (e.g., "person", "project")' },
          label: { type: 'string', description: 'Human-readable name for the entity' },
          summary: { type: 'string', description: 'Brief description of the entity' },
          properties: { type: 'object', description: 'Typed properties matching the vocabulary schema' },
        },
        required: ['entityType', 'label'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'memory_find_entities',
      description: 'Search for entities by label text, type, or properties.',
      parameters: {
        type: 'object',
        properties: {
          searchTerm: { type: 'string', description: 'Text to search for in entity labels and summaries' },
          entityTypes: { type: 'array', items: { type: 'string' }, description: 'Filter results to specific entity types' },
          limit: { type: 'number', description: 'Maximum number of results (default 10, max 50)' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'memory_create_relationship',
      description: 'Create a typed relationship between two existing entities.',
      parameters: {
        type: 'object',
        properties: {
          relationshipType: { type: 'string', description: 'Relationship type from the vocabulary' },
          sourceEntityId: { type: 'string', description: 'ID of the source entity' },
          targetEntityId: { type: 'string', description: 'ID of the target entity' },
        },
        required: ['relationshipType', 'sourceEntityId', 'targetEntityId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'memory_explore',
      description: 'Explore the neighborhood around an entity to see what it is connected to.',
      parameters: {
        type: 'object',
        properties: {
          entityId: { type: 'string', description: 'ID of the entity to explore from' },
          depth: { type: 'number', enum: [1, 2, 3], description: 'How many hops to explore (default 1)' },
        },
        required: ['entityId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'memory_get_vocabulary',
      description: 'Get the vocabulary showing what entity types and relationship types are available.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

// ─── Function Call Handler ─────────────────────────────────────────

export async function handleFunctionCall(
  repo: MemoryRepository,
  functionName: string,
  args: Record<string, unknown>,
): Promise<string> {
  let result: unknown;

  switch (functionName) {
    case 'memory_create_entity':
      result = await repo.createEntities([{
        entityType: args.entityType as string,
        label: args.label as string,
        summary: args.summary as string | undefined,
        properties: args.properties as Record<string, unknown> | undefined,
      }]);
      break;

    case 'memory_find_entities':
      result = await repo.findEntities({
        searchTerm: args.searchTerm as string | undefined,
        entityTypes: args.entityTypes as string[] | undefined,
        limit: args.limit as number | undefined,
      });
      break;

    case 'memory_create_relationship':
      result = await repo.createRelationships([{
        relationshipType: args.relationshipType as string,
        sourceEntityId: args.sourceEntityId as string,
        targetEntityId: args.targetEntityId as string,
      }]);
      break;

    case 'memory_explore':
      result = await repo.exploreNeighborhood(args.entityId as string, {
        depth: (args.depth as 1 | 2 | 3) ?? 1,
      });
      break;

    case 'memory_get_vocabulary':
      result = await repo.getVocabulary();
      break;

    default:
      throw new Error(`Unknown function: ${functionName}`);
  }

  // OpenAI expects function results as strings
  return JSON.stringify(result);
}
