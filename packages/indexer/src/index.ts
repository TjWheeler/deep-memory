// Types
export type {
  OrchestratorConfig,
  ExtractionConfig,
  ConsolidationConfig,
  ImportConfig,
  StorageProviderConfig,
  EmbeddingProviderConfig,
  WorkerConfig,
  WorkerCapability,
  EmbeddingsConfig,
  EmbeddingsWorkerConfig,
  QualityThresholds,
} from './types/config.js';
export { DEFAULT_QUALITY_THRESHOLDS } from './types/config.js';

export type {
  ExtractionOutput,
  ExtractedEntity,
  ExtractedRelationship,
  SourceRef,
  TruncationInfo,
} from './types/extraction.js';

export type {
  EntityRegistry,
  RegistryEntry,
  RegistryEntryStatus,
} from './types/registry.js';

export type {
  IndexSourceList,
  IndexSource,
  IndexSourceStatus,
  DocumentTokenEstimate,
} from './types/source-list.js';

// Orchestrator
export { IndexingOrchestrator } from './orchestrator/IndexingOrchestrator.js';
export type { PipelineResult } from './orchestrator/IndexingOrchestrator.js';
export { StateManager, Phase } from './orchestrator/StateManager.js';
export type { PipelinePhase } from './orchestrator/StateManager.js';

// Analysis
export { DocumentAnalyzer, singleWorkerFromConfig, reassignFailedSource, estimateValidationCost } from './orchestrator/DocumentAnalyzer.js';
export type { DocumentAnalysis, WorkerAnalysisSummary, AnalysisReport } from './orchestrator/DocumentAnalyzer.js';

// Process config
export { loadProcessConfig } from './orchestrator/ProcessConfigLoader.js';
export type { IndexProcessConfig, IndexProcessSecrets } from './orchestrator/ProcessConfigLoader.js';
export { ProcessStateWriter } from './orchestrator/ProcessStateWriter.js';
export type { ProcessPhase, ProcessIteration } from './orchestrator/ProcessStateWriter.js';

// Extraction
export { ExtractionWorker } from './extraction/ExtractionWorker.js';
export { PromptBuilder } from './extraction/PromptBuilder.js';
export { isMarkdownStructured, splitIntoChapters, generateOverview } from './extraction/ChapterSplitter.js';
export type { Chapter, DocumentOverview } from './extraction/ChapterSplitter.js';
export { ProgressiveContext } from './extraction/ProgressiveContext.js';
export type { ProgressiveContextSnapshot } from './extraction/ProgressiveContext.js';
export type { ExtractionProgress, OnExtractionProgress, ExtractionCheckpoint } from './extraction/ExtractionProgress.js';

// Embeddings
export { EmbeddingsOrchestrator } from './embeddings/EmbeddingsOrchestrator.js';
export type { EmbeddingProgress, EmbeddingsDependencies, EmbeddingEntity, EmbeddingEntityPage, EmbeddingWorkerStats } from './embeddings/EmbeddingsOrchestrator.js';

// Consolidation
export { Consolidator } from './consolidation/Consolidator.js';
export type { ConsolidationReport, ConsolidationPipelineContext } from './consolidation/Consolidator.js';
export { EntityMatcher } from './consolidation/EntityMatcher.js';
export type { MatchResult } from './consolidation/EntityMatcher.js';
export type { MergeEvent, MergeLog, MergeMatchType } from './consolidation/types.js';
export { parseVocabularyMarkdown, augmentVocabularyFromData } from './consolidation/VocabularyMarkdownParser.js';

// Import
export { BatchImporter } from './import/BatchImporter.js';
export type { BatchImportOptions } from './import/BatchImporter.js';

// Providers
export type {
  LLMProvider,
  LLMCompletionResult,
  LLMRequestOptions,
  LLMRunContext,
  LLMToolDefinition,
  LLMToolCallRequest,
  LLMToolUseContent,
  LLMToolUseMessage,
  LLMToolUseTurnResult,
} from './providers/LLMProvider.js';
export { OpenAIChatProvider, type OpenAIChatProviderConfig } from './providers/OpenAIChatProvider.js';

// Review
export { ReviewDiagnostics } from './review/ReviewDiagnostics.js';
export { ConsolidationReviewDiagnostics } from './review/ConsolidationReviewDiagnostics.js';
export type {
  ReviewReport,
  AggregateMetrics,
  DocumentDiagnostics,
  OrphanExample,
  QualityRating,
  WorkerSummary,
  WorkerComparison,
  SourceComparison,
} from './review/types.js';
export type {
  ConsolidationReviewReport,
  MergeConfidenceReport,
  AliasSpecificityReport,
  CrossSourceMergeReport,
  TypeConsistencyReport,
  MergeStatisticsReport,
} from './review/consolidation-review-types.js';

// Validation
export { Validator } from './validation/Validator.js';
export { VerificationWorker, readSourceContent } from './validation/VerificationWorker.js';
export { CheckpointManager } from './validation/CheckpointManager.js';
export { ValidationRulesLoader } from './validation/ValidationRulesLoader.js';
export type {
  ValidationRules,
  PropertyRange,
  StructuralRules,
  ValidationResult,
  ValidationIssue,
  Tier1Result,
  Tier2Result,
  CheckpointResult,
  ValidationConfig,
  VerificationResponse,
  PropertyVerdict,
} from './types/validation.js';

// Full Validation (Phase B.7)
export { FullValidationWorker } from './validation/FullValidationWorker.js';
export { summarizeVocabularyForValidation } from './validation/VocabularySummarizer.js';
export { ValidationToolProvider } from './validation/ValidationToolProvider.js';
export { FullValidationOrchestrator } from './validation/FullValidationOrchestrator.js';
export type { FullValidationRunOptions, FullValidationProgressCallbacks } from './validation/FullValidationOrchestrator.js';
export type {
  FullValidationVerdict,
  FullValidationWorkerConfig,
  FullValidationHybridConfig,
  FullValidationConfig,
  BatchItemType,
  EntityBatchItem,
  RelationshipBatchItem,
  ValidationBatchItem,
  ValidationBatch,
  PropertyValidationResult,
  EntityValidationResult,
  RelationshipValidationResult,
  BatchValidationResult,
  VerdictCounts,
  ValidationCostTracker,
  BatchCheckpoint,
  FullValidationProgress,
  DocumentValidationSummary,
  EntityTypeValidationSummary,
  FlaggedValidationItem,
  ProposedCorrection,
  CorrectionOperation,
  FullValidationReport,
  ValidationCostEstimate,
} from './validation/full-validation-types.js';
