/**
 * Anthropic Tool Definitions — map Deep Memory operations to Anthropic's tool use format.
 *
 * Pass these to the `tools` parameter of the Messages API.
 * When Claude returns a tool_use block, route it through handleToolUse().
 */

import type { MemoryRepository } from '@utaba/deep-memory';

// ─── Anthropic Tool Definitions ────────────────────────────────────

export const TOOLS = [
  {
    name: 'memory_create_entity',
    description: 'Create a new entity in the knowledge graph. The entity type must exist in the vocabulary. Returns the created entity with its auto-generated ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        entityType: { type: 'string', description: 'Entity type from the vocabulary (e.g., "person", "project")' },
        label: { type: 'string', description: 'Human-readable name for the entity' },
        summary: { type: 'string', description: 'Brief description of the entity' },
        properties: {
          type: 'object',
          description: 'Typed properties matching the vocabulary schema for this entity type',
        },
      },
      required: ['entityType', 'label'],
    },
  },
  {
    name: 'memory_find_entities',
    description: 'Search for entities in the knowledge graph by label text, type, or properties. Returns a paginated list of matching entities.',
    input_schema: {
      type: 'object' as const,
      properties: {
        searchTerm: { type: 'string', description: 'Text to search for in entity labels and summaries' },
        entityTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter results to specific entity types',
        },
        limit: { type: 'number', description: 'Maximum number of results (default 10, max 50)' },
      },
    },
  },
  {
    name: 'memory_create_relationship',
    description: 'Create a typed, directional relationship between two existing entities. The relationship type must exist in the vocabulary, and the source/target entity types must match the allowed types.',
    input_schema: {
      type: 'object' as const,
      properties: {
        relationshipType: { type: 'string', description: 'Relationship type from the vocabulary' },
        sourceEntityId: { type: 'string', description: 'ID of the source entity' },
        targetEntityId: { type: 'string', description: 'ID of the target entity' },
        properties: { type: 'object', description: 'Optional relationship properties' },
      },
      required: ['relationshipType', 'sourceEntityId', 'targetEntityId'],
    },
  },
  {
    name: 'memory_explore',
    description: 'Explore the neighborhood around an entity to discover what it is connected to. Returns connected entities grouped by relationship type.',
    input_schema: {
      type: 'object' as const,
      properties: {
        entityId: { type: 'string', description: 'ID of the entity to explore from' },
        depth: {
          type: 'number',
          enum: [1, 2, 3],
          description: 'How many relationship hops to explore (default 1)',
        },
        relationshipTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only follow these relationship types',
        },
      },
      required: ['entityId'],
    },
  },
  {
    name: 'memory_get_vocabulary',
    description: 'Get the repository vocabulary showing all available entity types, relationship types, and their property schemas. Use this to understand what types of knowledge can be stored.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

// ─── Tool Use Handler ──────────────────────────────────────────────

export async function handleToolUse(
  repo: MemoryRepository,
  toolName: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (toolName) {
    case 'memory_create_entity':
      return repo.createEntities([{
        entityType: input.entityType as string,
        label: input.label as string,
        summary: input.summary as string | undefined,
        properties: input.properties as Record<string, unknown> | undefined,
      }]);

    case 'memory_find_entities':
      return repo.findEntities({
        searchTerm: input.searchTerm as string | undefined,
        entityTypes: input.entityTypes as string[] | undefined,
        limit: input.limit as number | undefined,
      });

    case 'memory_create_relationship':
      return repo.createRelationships([{
        relationshipType: input.relationshipType as string,
        sourceEntityId: input.sourceEntityId as string,
        targetEntityId: input.targetEntityId as string,
        properties: input.properties as Record<string, unknown> | undefined,
      }]);

    case 'memory_explore':
      return repo.exploreNeighborhood(input.entityId as string, {
        depth: (input.depth as 1 | 2 | 3) ?? 1,
        relationshipTypes: input.relationshipTypes as string[] | undefined,
      });

    case 'memory_get_vocabulary':
      return repo.getVocabulary();

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
