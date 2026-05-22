/**
 * Types for the three-tier validation model.
 *
 * Tier 1: Automated schema, range, and structural checks (zero LLM cost)
 * Tier 2: Source-grounded LLM verification (low LLM cost)
 * Tier 3: Statistical sampling + human review (periodic)
 */

/** Validation rules loaded from the starter kit */
export interface ValidationRules {
  version: string;
  domain: string;
  propertyRanges: Record<string, Record<string, PropertyRange>>;
  relationshipRanges: Record<string, Record<string, PropertyRange>>;
  structuralRules: StructuralRules;
}

/** Range/format constraint for a single property */
export interface PropertyRange {
  type: 'number' | 'integer' | 'string' | 'percentage';
  unit?: string;
  min?: number;
  max?: number;
  /** Regex pattern for string validation */
  pattern?: string;
  /** Allowed values for enum-style validation */
  enum?: string[];
}

/** Structural integrity rules */
export interface StructuralRules {
  /** Entity types that must have specific relationships */
  requiredRelationships?: Record<string, string[]>;
  /** Whether orphan entities (no relationships) are flagged */
  noOrphans?: boolean;
  /** Maximum entities per single extraction */
  maxEntitiesPerExtraction?: number;
  /** Maximum relationships per single extraction */
  maxRelationshipsPerExtraction?: number;
}

/** Result of validating a single extraction */
export interface ValidationResult {
  /** Source document that was validated */
  source: string;
  /** Tier 1 check summary */
  tier1: Tier1Result;
  /** Tier 2 verification summary (if run) */
  tier2?: Tier2Result;
  /** Overall verdict across all tiers */
  overallVerdict: 'pass' | 'warnings' | 'fail';
  /** Blocking issues that must be resolved */
  errors: ValidationIssue[];
  /** Non-blocking issues that should be reviewed */
  warnings: ValidationIssue[];
}

/** A single validation issue (error or warning) */
export interface ValidationIssue {
  tier: 1 | 2 | 3;
  severity: 'error' | 'warning';
  /** Entity label the issue pertains to */
  entityLabel?: string;
  /** Relationship type the issue pertains to */
  relationshipType?: string;
  /** Property name the issue pertains to */
  property?: string;
  /** Human-readable description of the issue */
  message: string;
  /** The value that was extracted */
  extractedValue?: unknown;
  /** Description of the expected range or format */
  expectedRange?: string;
  /** Source text evidence (from Tier 2) */
  sourceEvidence?: string;
  /** Tier 2 LLM verdict */
  verdict?: 'confirmed' | 'unsupported' | 'contradicted';
}

/** Summary of Tier 1 automated checks */
export interface Tier1Result {
  schemaErrors: number;
  rangeViolations: number;
  structuralIssues: number;
  passed: boolean;
}

/** Summary of Tier 2 source-grounded verification */
export interface Tier2Result {
  entitiesVerified: number;
  propertiesVerified: number;
  confirmed: number;
  unsupported: number;
  contradicted: number;
  passed: boolean;
}

/** Checkpoint result during Phase D import */
export interface CheckpointResult {
  batchNumber: number;
  documentsInBatch: number;
  documentsCumulative: number;
  tier1: Tier1Result;
  tier2?: Tier2Result;
  verdict: 'continue' | 'warnings' | 'review-required';
  flaggedItems: ValidationIssue[];
}

/** Configuration for validation behavior */
export interface ValidationConfig {
  /** Path to validation-rules.json in the starter kit */
  rulesPath: string;
  /** Tier 2 scope: verify all, a sample, or only flagged items */
  tier2Scope: 'all' | 'sample' | 'flagged-only';
  /** Sample percentage for Tier 2 when scope is 'sample' (0-100) */
  tier2SamplePercent?: number;
  /** LLM endpoint for Tier 2 verification (can differ from extraction endpoint) */
  verificationEndpoint?: string;
  /** Model for Tier 2 verification */
  verificationModel?: string;
  /** Phase D checkpoint interval (documents per checkpoint, 0 to disable) */
  checkpointInterval: number;
  /** Whether to pause on warnings (default: only pause on errors) */
  pauseOnWarnings?: boolean;
  /** Tier 3: percentage of extractions flagged for human review (0 to disable) */
  humanReviewPercent?: number;
}

/** Verification prompt response from the LLM */
export interface VerificationResponse {
  properties: Record<string, PropertyVerdict>;
}

/** LLM verdict for a single property */
export interface PropertyVerdict {
  verdict: 'confirmed' | 'unsupported' | 'contradicted';
  evidence: string;
}
