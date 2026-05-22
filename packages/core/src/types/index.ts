// Type re-exports — @utaba/deep-memory/types

export type {
  ProvenanceContext,
  Provenance,
} from './provenance.js';

export type {
  PropertyType,
  PropertySchema,
  EntityTypeDefinition,
  RelationshipTypeDefinition,
  MemoryVocabulary,
  GovernanceMode,
  GovernanceConfig,
  VocabularyProposal,
  VocabularyProposalResult,
  VocabularyChangeRecord,
  ResolvedVocabulary,
  EntityTypeInput,
  RelationshipTypeInput,
  VocabularyInput,
} from './vocabulary.js';

export type {
  DetailLevel,
  Entity,
  EntitySummary,
  EntityBrief,
  CreateEntityInput,
  UpdateEntityInput,
  StoredEntity,
  StoredEntityUpdate,
  GetEntityOptions,
  GetEntitiesOptions,
  DeleteEntitiesResult,
} from './entities.js';

export type {
  RelationshipDirection,
  Relationship,
  EnrichedRelationship,
  CreateRelationshipInput,
  StoredRelationship,
  RelationshipQueryOptions,
  RelationshipSummary,
  RemoveRelationshipsResult,
} from './relationships.js';

export type {
  RepositoryConfig,
  RepositoryMetadata,
  RepositoryUpdate,
  RepositorySummary,
  RepositoryStats,
  StoredRepository,
  StoredRepositorySummary,
  RepositoryFilter,
  StorageRepositoryConfig,
} from './repositories.js';

export type {
  PaginationOptions,
  FindEntitiesQuery,
  ExploreOptions,
  PathOptions,
  ConceptSearchOptions,
  TimelineOptions,
  StorageFindQuery,
  StorageExploreOptions,
  StoragePathOptions,
  StorageTimelineOptions,
  SearchOptions,
  PropertyFilter,
  ProvenanceFilter,
} from './queries.js';

export type {
  PaginatedResult,
  NeighborhoodCenter,
  NeighborhoodGroup,
  NeighborhoodLayer,
  Neighborhood,
  Path,
  PathResult,
  ScoredEntity,
  TimelineEntityRef,
  TimelineRelationshipDetail,
  TimelineEvent,
  TimelineResult,
  GraphResult,
  EntityMap,
  StorageNeighborhoodGroup,
  StorageNeighborhoodLayer,
  StorageNeighborhood,
  StoragePath,
  StoragePathResult,
  StorageTimelineEvent,
  StorageTimelineResult,
  SearchHit,
  BulkImportResult,
  ReembedResult,
  EntityValidationIssue,
  RelationshipValidationIssue,
  EntityValidationPage,
  RelationshipValidationPage,
  ValidateEntitiesOptions,
  ValidateRelationshipsOptions,
} from './results.js';

export type {
  DeepMemoryEventType,
  EventPayload,
  DeepMemoryEvent,
  EventHandler,
  Unsubscribe,
  HookResult,
} from './events.js';

export type {
  TraversalSpec,
  TraversalStart,
  TraversalStep,
  TraversalProjection,
  TraversalReturnMode,
  TraversalResult,
  TraversalAggregation,
  TraversalRelationship,
  TraversalPath,
  QueryMetadata,
} from './traversal.js';

export type {
  OperationUsage,
  UsageSink,
} from './usage.js';

export type {
  ExportManifest,
  ExportLegalMetadata,
  ExportPipelineMetadata,
  ExportOptions,
  ExportArchive,
  ExportChunk,
  ExportStreamItem,
  ImportOptions,
  ImportChunk,
  BulkImportOptions,
  AdaptiveConcurrencyOptions,
  AdaptiveConcurrencyAdjustEvent,
  AdaptiveConcurrencyAdjustReason,
  AdaptiveConcurrencyHandle,
  DeleteProgressCallback,
  ImportStreamHeader,
  ImportWarning,
  ImportResult,
} from './portability.js';
