import type { ILogger } from '../interfaces/ILogger.js';
import type { IMcpTool } from '../interfaces/IMcpTool.js';
import type { ToolContext } from '../tools/base/BaseToolController.js';

// Repository tools
import { CreateRepositoryTool } from '../tools/repository/CreateRepositoryTool.js';
import { OpenRepositoryTool } from '../tools/repository/OpenRepositoryTool.js';
import { ListRepositoriesTool } from '../tools/repository/ListRepositoriesTool.js';
import { GetRepositoryTool } from '../tools/repository/GetRepositoryTool.js';
import { UpdateRepositoryTool } from '../tools/repository/UpdateRepositoryTool.js';
import { DeleteRepositoryTool } from '../tools/repository/DeleteRepositoryTool.js';
import { EnsureSchemaTool } from '../tools/repository/EnsureSchemaTool.js';
import { ValidateEntitiesTool } from '../tools/repository/ValidateEntitiesTool.js';
import { ValidateRelationshipsTool } from '../tools/repository/ValidateRelationshipsTool.js';

// Entity tools
import { CreateEntitiesTool } from '../tools/entity/CreateEntitiesTool.js';
import { UpdateEntityTool } from '../tools/entity/UpdateEntityTool.js';
import { GetEntityTool } from '../tools/entity/GetEntityTool.js';
import { FindEntitiesTool } from '../tools/entity/FindEntitiesTool.js';
import { DeleteEntitiesTool } from '../tools/entity/DeleteEntitiesTool.js';
import { ReembedRepositoryTool } from '../tools/entity/ReembedRepositoryTool.js';

// Relationship tools
import { CreateRelationshipsTool } from '../tools/relationship/CreateRelationshipsTool.js';
import { RemoveRelationshipsTool } from '../tools/relationship/RemoveRelationshipsTool.js';
import { GetRelationshipsTool } from '../tools/relationship/GetRelationshipsTool.js';

// Graph traversal tools
import { ExploreNeighborhoodTool } from '../tools/graph/ExploreNeighborhoodTool.js';
import { FindPathsTool } from '../tools/graph/FindPathsTool.js';
import { GetGraphTool } from '../tools/graph/GetGraphTool.js';
import { QueryGraphTool } from '../tools/graph/QueryGraphTool.js';

// Search tools
import { SearchByConceptTool } from '../tools/search/SearchByConceptTool.js';

// Vocabulary tools
import { GetVocabularyTool } from '../tools/vocabulary/GetVocabularyTool.js';
import { ProposeVocabularyExtensionTool } from '../tools/vocabulary/ProposeVocabularyExtensionTool.js';

// Stats tools
import { GetStatsTool } from '../tools/stats/GetStatsTool.js';
import { GetTimelineTool } from '../tools/stats/GetTimelineTool.js';

// Portability tools
import { ExportRepositoryTool } from '../tools/portability/ExportRepositoryTool.js';
import { ImportRepositoryTool } from '../tools/portability/ImportRepositoryTool.js';

export interface ToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class ToolRegistry {
  private tools: Map<string, IMcpTool> = new Map();

  constructor(
    private context: ToolContext,
    private logger: ILogger,
  ) {
    this.registerTools();
  }

  private registerTools(): void {
    // Repository lifecycle
    this.register(new CreateRepositoryTool(this.context, this.logger));
    this.register(new OpenRepositoryTool(this.context, this.logger));
    this.register(new ListRepositoriesTool(this.context, this.logger));
    this.register(new GetRepositoryTool(this.context, this.logger));
    this.register(new UpdateRepositoryTool(this.context, this.logger));
    this.register(new DeleteRepositoryTool(this.context, this.logger));
    this.register(new EnsureSchemaTool(this.context, this.logger));
    this.register(new ValidateEntitiesTool(this.context, this.logger));
    this.register(new ValidateRelationshipsTool(this.context, this.logger));

    // Entity operations
    this.register(new CreateEntitiesTool(this.context, this.logger));
    this.register(new UpdateEntityTool(this.context, this.logger));
    this.register(new GetEntityTool(this.context, this.logger));
    this.register(new FindEntitiesTool(this.context, this.logger));
    this.register(new DeleteEntitiesTool(this.context, this.logger));
    this.register(new ReembedRepositoryTool(this.context, this.logger));

    // Relationship operations
    this.register(new CreateRelationshipsTool(this.context, this.logger));
    this.register(new RemoveRelationshipsTool(this.context, this.logger));
    this.register(new GetRelationshipsTool(this.context, this.logger));

    // Graph traversal
    this.register(new ExploreNeighborhoodTool(this.context, this.logger));
    this.register(new FindPathsTool(this.context, this.logger));
    this.register(new GetGraphTool(this.context, this.logger));
    this.register(new QueryGraphTool(this.context, this.logger));

    // Search
    this.register(new SearchByConceptTool(this.context, this.logger));

    // Vocabulary
    this.register(new GetVocabularyTool(this.context, this.logger));
    this.register(new ProposeVocabularyExtensionTool(this.context, this.logger));

    // Stats & timeline
    this.register(new GetStatsTool(this.context, this.logger));
    this.register(new GetTimelineTool(this.context, this.logger));

    // Portability
    this.register(new ExportRepositoryTool(this.context, this.logger, this.context.exportDir));
    this.register(new ImportRepositoryTool(this.context, this.logger));

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
