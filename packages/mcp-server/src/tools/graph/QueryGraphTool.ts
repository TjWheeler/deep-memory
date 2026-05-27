import { BaseToolController } from '../base/BaseToolController.js';
import type { TraversalSpec } from '@utaba/deep-memory';

const propertyFilterSchema = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    operator: { type: 'string', enum: ['eq', 'neq', 'isNull', 'isNotNull', 'gt', 'lt', 'gte', 'lte', 'contains'] },
    value: {},
  },
  required: ['key', 'operator'],
};

export class QueryGraphTool extends BaseToolController {
  get name() { return 'memory_query_graph'; }
  get description() {
    return `Query the knowledge graph — vertex lookups, property projection, and multi-hop traversals in a single tool.

## Projection (property extraction and aggregation)

Use \`projection\` to extract property values from entities. When projection is present, only the aggregated values are returned (no entity objects) — this keeps responses lightweight. Set \`projection.includeEntities: true\` if you also need the full entity objects.

- Distinct values: \`{ start: { entityType: "Equipment" }, projection: { properties: ["equipmentType"], distinct: true }, limit: 200 }\`
- Count by value: \`{ start: { entityType: "Equipment" }, projection: { properties: ["equipmentType"], mode: "count" }, limit: 200 }\`
- Multi-property: \`{ start: { entityType: "Equipment" }, projection: { properties: ["equipmentType", "tier"], distinct: true }, limit: 200 }\`

## Vertex queries (no steps, no projection)

Query entities directly by type and properties — returns entity objects:
- By type: \`{ start: { entityType: "Fluid" }, limit: 50 }\`
- With filter: \`{ start: { entityType: "Fluid", filter: [{ key: "fluidType", operator: "eq", value: "hydraulic-oil" }] }, limit: 50 }\`

## Traversals (with steps)

Follow relationships through the graph:
- 2-hop: \`{ start: { entityId: "Equipment:komatsu-pc7000-11" }, steps: [{ direction: "out", relationshipTypes: ["HAS_COMPONENT"] }, { direction: "out", relationshipTypes: ["REQUIRES_FLUID"] }] }\`
- Filtered edges: \`{ start: { entityId: "Equipment:komatsu-pc7000-11" }, steps: [{ direction: "both", relationshipTypes: ["COMPATIBLE_WITH"], relationshipFilter: [{ key: "passCount", operator: "gte", value: 3 }] }] }\`
- Variable depth: \`{ start: { entityId: "..." }, steps: [{ direction: "out", relationshipTypes: ["CONTAINS"], repeat: { maxDepth: 5 } }] }\`

Projection works with traversals too — add \`projection\` to aggregate properties from the traversal results.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository to query' },
        start: {
          type: 'object',
          description: 'Which entities to query or start traversing from',
          properties: {
            entityId: { type: 'string', description: 'Specific entity by ID (GUID) or slug' },
            entityType: { type: 'string', description: 'All entities of a given type (requires limit)' },
            filter: { type: 'array', items: propertyFilterSchema, description: 'Filter entities by property values' },
          },
        },
        steps: {
          type: 'array',
          description: 'Relationship hops to follow. Omit for vertex-only queries.',
          items: {
            type: 'object',
            properties: {
              direction: { type: 'string', enum: ['out', 'in', 'both'], description: 'Direction to traverse, relative to the entity at the start of the hop' },
              relationshipTypes: { type: 'array', items: { type: 'string' }, description: 'Relationship types to follow (omit for all)' },
              entityTypes: { type: 'array', items: { type: 'string' }, description: 'Filter target entities by type' },
              relationshipFilter: { type: 'array', items: propertyFilterSchema, description: 'Filter relationships by property values' },
              entityFilter: { type: 'array', items: propertyFilterSchema, description: 'Filter target entities by property values' },
              repeat: {
                type: 'object',
                description: 'Repeat this step for variable-depth traversal',
                properties: {
                  maxDepth: { type: 'number', description: 'Maximum iterations (required)' },
                  until: { type: 'array', items: propertyFilterSchema, description: 'Stop when entity matches these filters' },
                  emitIntermediates: { type: 'boolean', description: 'Include intermediate entities (default: true)' },
                },
                required: ['maxDepth'],
              },
            },
            required: ['direction'],
          },
        },
        projection: {
          type: 'object',
          description: 'Property projection — extract and aggregate property values from result entities. When present, only aggregations are returned (no entity objects). Set includeEntities: true to also get entity objects.',
          properties: {
            properties: { type: 'array', items: { type: 'string' }, description: 'Property names to extract from entities' },
            distinct: { type: 'boolean', description: 'Return only distinct value combinations (default: false)' },
            mode: { type: 'string', enum: ['values', 'count'], description: 'values (default): raw property values. count: count entities per distinct combination' },
            includeEntities: { type: 'boolean', description: 'Also return full entity objects alongside projections (default: false)' },
          },
          required: ['properties'],
        },
        returnMode: { type: 'string', enum: ['terminal', 'path', 'all'], description: 'What to return (default: terminal)' },
        limit: { type: 'number', description: 'Maximum results (default: 50, max: 200)' },
        offset: { type: 'number', description: 'Pagination offset (default: 0)' },
        detailLevel: { type: 'string', enum: ['brief', 'summary', 'full'], description: 'Detail level for entities (default: summary)' },
        dedup: { type: 'boolean', description: 'Deduplicate entities (default: true)' },
        includeRelationshipSummary: { type: 'boolean', description: 'Attach out/in relationship counts by type to each entity (default: true). Set false to reduce response size.' },
      },
      required: ['repositoryId', 'start'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repo = await this.context.getRepository(params['repositoryId'] as string);

    const start = params['start'] as TraversalSpec['start'];
    if (start.entityId) {
      start.entityId = await this.resolveEntityId(repo, start.entityId);
    }

    const spec: TraversalSpec = {
      start,
      steps: params['steps'] as TraversalSpec['steps'],
      returnMode: (params['returnMode'] as TraversalSpec['returnMode']) ?? 'terminal',
      projection: params['projection'] as TraversalSpec['projection'],
      limit: params['limit'] as number | undefined,
      offset: params['offset'] as number | undefined,
      detailLevel: params['detailLevel'] as 'brief' | 'summary' | 'full' | undefined,
      dedup: params['dedup'] as boolean | undefined,
      includeRelationshipSummary: (params['includeRelationshipSummary'] as boolean | undefined) ?? true,
      includeProvenance: false,
    };

    return repo.traverse(spec);
  }
}
