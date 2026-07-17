import { readFile, access } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import type { OrchestratorConfig, WorkerConfig, ExtractionConfig, ConsolidationConfig, QualityThresholds, ServicesConfig, DoclingServiceConfig } from '../types/config.js';
import { DEFAULT_QUALITY_THRESHOLDS } from '../types/config.js';
import type { FullValidationConfig, FullValidationWorkerConfig } from '../validation/full-validation-types.js';

const CONFIG_FILE = 'config.json';
const SECRETS_FILE = 'config.secrets.json';
const STATE_DIR = 'state';

/**
 * Process-level config file format.
 * Everything a named indexing process needs, stored in config.json.
 */
export interface IndexProcessConfig {
  /** Human-readable name for this indexing process */
  name: string;
  /** Relative path to the starter kit directory */
  starterKit: string;
  /** Target deep-memory repository ID */
  repositoryId: string;
  /** Path to source documents directory (relative to processDir or absolute) */
  sourceDir: string;
  /** Extraction configuration */
  extraction: {
    endpoint: string;
    model: string;
    concurrency?: number;
    maxTokens?: number;
    temperature?: number;
    maxChunkSize?: number;
    extraBodyParams?: Record<string, unknown>;
    workers?: WorkerConfig[];
    maxItems?: number;
    sourceFilter?: string[];
    autoReassignFailures?: boolean;
  };
  /** Consolidation configuration */
  consolidation?: {
    endpoint?: string;
    model?: string;
    apiKey?: string;
    maxTokens?: number;
  };
  /** Validation configuration */
  validation?: {
    rulesPath?: string;
    tier2Scope?: 'all' | 'sample' | 'flagged-only';
    tier2SamplePercent?: number;
    verificationEndpoint?: string;
    verificationModel?: string;
    checkpointInterval?: number;
  };
  /** Full extraction validation configuration */
  fullValidation?: {
    workers?: FullValidationWorkerConfig[];
    defaultWorker?: string;
    batchSize?: number;
    maxBatches?: number;
    maxCost?: number;
    maxRetries?: number;
  };
  /** Embeddings configuration */
  embeddings?: {
    endpoint: string;
    model: string;
    apiKey?: string;
    dimensions?: number;
    batchSize?: number;
    delayBetweenBatchesMs?: number;
    maxRetries?: number;
    errorThresholdToAbort?: number;
    costPerMillionTokens?: number;
    averageTokensPerEntity?: number;
  };
  /** Import phase configuration — storage provider for the target repository */
  import?: {
    storage: {
      type: string;
      config?: Record<string, unknown>;
    };
  };
  /** External services the pipeline can call (e.g. document conversion) */
  services?: {
    docling?: {
      endpoint?: string;
      timeoutMs?: number;
      maxRetries?: number;
      doOcr?: boolean;
      apiKey?: string;
      mode?: 'sync' | 'async';
      pollIntervalMs?: number;
      maxPollIntervalMs?: number;
      maxTotalWaitMs?: number;
      ocrTextYieldThreshold?: number;
    };
  };
  /** Quality thresholds for review diagnostics (optional — defaults applied if omitted) */
  qualityThresholds?: Partial<{
    extraction: Partial<QualityThresholds['extraction']>;
    consolidation: Partial<QualityThresholds['consolidation']>;
  }>;
}

/**
 * Secrets file format — nested structure that patches into config.
 * Worker secrets are keyed by worker name.
 */
export interface IndexProcessSecrets {
  extraction?: {
    workers?: Record<string, { apiKey?: string }>;
  };
  consolidation?: {
    apiKey?: string;
  };
  /** API keys for full validation workers */
  validation?: {
    workers?: Record<string, { apiKey?: string }>;
  };
  /** API key for embeddings endpoint */
  embeddings?: {
    apiKey?: string;
  };
  /** API key for the document-conversion service */
  docling?: {
    apiKey?: string;
  };
}

/**
 * Load and resolve a processDir into a fully-populated OrchestratorConfig.
 *
 * Loads config.json, optionally merges config.secrets.json, resolves
 * relative paths (starterKit, sourceDir, stateDir), and returns a
 * config ready to pass to IndexingOrchestrator.
 *
 * MCP tool parameter overrides (maxItems, sourceFilter, etc.) are applied
 * after loading the config file.
 */
export async function loadProcessConfig(
  processDir: string,
  overrides?: Partial<{
    maxItems: number;
    sourceFilter: string[];
    autoReassignFailures: boolean;
    sourceDir: string;
  }>,
): Promise<{ config: OrchestratorConfig; processConfig: IndexProcessConfig; sourceDir: string }> {
  const absProcessDir = resolve(processDir);

  // Load config.json
  const configPath = join(absProcessDir, CONFIG_FILE);
  const configContent = await readFile(configPath, 'utf-8');
  const processConfig = JSON.parse(configContent) as IndexProcessConfig;

  // Load secrets if present
  let secrets: IndexProcessSecrets = {};
  const secretsPath = join(absProcessDir, SECRETS_FILE);
  try {
    await access(secretsPath);
    const secretsContent = await readFile(secretsPath, 'utf-8');
    secrets = JSON.parse(secretsContent) as IndexProcessSecrets;
  } catch {
    // No secrets file — fine
  }

  // Resolve paths relative to processDir
  const starterKitDir = resolvePath(absProcessDir, processConfig.starterKit);
  const stateDir = join(absProcessDir, STATE_DIR);
  const sourceDir = overrides?.sourceDir
    ? resolvePath(absProcessDir, overrides.sourceDir)
    : resolvePath(absProcessDir, processConfig.sourceDir);

  // Resolve starter kit files
  const vocabularyPath = join(starterKitDir, 'vocabulary.md');
  const extractionRulesPath = await fileExists(join(starterKitDir, 'indexing-strategy.md'))
    ? join(starterKitDir, 'indexing-strategy.md')
    : undefined;
  const domainGuidancePath = await fileExists(join(starterKitDir, 'domain-guidance.md'))
    ? join(starterKitDir, 'domain-guidance.md')
    : undefined;

  // Build workers with secrets merged
  let workers = processConfig.extraction.workers;
  if (workers && secrets.extraction?.workers) {
    workers = workers.map(w => {
      const workerSecrets = secrets.extraction?.workers?.[w.name];
      if (workerSecrets) {
        return { ...w, ...workerSecrets };
      }
      return w;
    });
  }

  // Build extraction config
  const extraction: ExtractionConfig = {
    endpoint: processConfig.extraction.endpoint,
    model: processConfig.extraction.model,
    concurrency: processConfig.extraction.concurrency ?? 3,
    maxTokens: processConfig.extraction.maxTokens,
    temperature: processConfig.extraction.temperature ?? 0,
    maxChunkSize: processConfig.extraction.maxChunkSize,
    extraBodyParams: processConfig.extraction.extraBodyParams,
    workers,
    maxItems: overrides?.maxItems ?? processConfig.extraction.maxItems,
    sourceFilter: overrides?.sourceFilter ?? processConfig.extraction.sourceFilter,
    autoReassignFailures: overrides?.autoReassignFailures ?? processConfig.extraction.autoReassignFailures,
  };

  // Build consolidation config
  const consolidation: ConsolidationConfig = {
    endpoint: processConfig.consolidation?.endpoint ?? processConfig.extraction.endpoint,
    model: processConfig.consolidation?.model ?? processConfig.extraction.model,
    apiKey: secrets.consolidation?.apiKey ?? processConfig.consolidation?.apiKey,
    maxTokens: processConfig.consolidation?.maxTokens,
  };

  // Build validation config
  const validationRulesPath = processConfig.validation?.rulesPath
    ? resolvePath(absProcessDir, processConfig.validation.rulesPath)
    : await fileExists(join(starterKitDir, 'validation-rules.json'))
      ? join(starterKitDir, 'validation-rules.json')
      : undefined;

  const validation = validationRulesPath
    ? {
        rulesPath: validationRulesPath,
        tier2Scope: processConfig.validation?.tier2Scope ?? ('all' as const),
        tier2SamplePercent: processConfig.validation?.tier2SamplePercent,
        verificationEndpoint: processConfig.validation?.verificationEndpoint ?? processConfig.extraction.endpoint,
        verificationModel: processConfig.validation?.verificationModel ?? processConfig.extraction.model,
        checkpointInterval: processConfig.validation?.checkpointInterval ?? 50,
      }
    : undefined;

  // Build full extraction validation config
  let fullValidation: FullValidationConfig | undefined;
  if (processConfig.fullValidation?.workers && processConfig.fullValidation.workers.length > 0) {
    // Merge worker secrets
    const validationWorkers = processConfig.fullValidation.workers.map(w => {
      const workerSecrets = secrets.validation?.workers?.[w.name];
      return workerSecrets ? { ...w, ...workerSecrets } : w;
    });

    fullValidation = {
      workers: validationWorkers,
      defaultWorker: processConfig.fullValidation.defaultWorker ?? validationWorkers[0]!.name,
      batchSize: processConfig.fullValidation.batchSize ?? 10,
      maxBatches: processConfig.fullValidation.maxBatches,
      maxCost: processConfig.fullValidation.maxCost,
      maxRetries: processConfig.fullValidation.maxRetries ?? 2,
    };
  }

  // Build embeddings config
  const embeddings = processConfig.embeddings
    ? {
        ...processConfig.embeddings,
        apiKey: secrets.embeddings?.apiKey ?? processConfig.embeddings.apiKey,
      }
    : undefined;

  // Build quality thresholds — deep-merge user overrides onto defaults
  const qualityThresholds: QualityThresholds = {
    extraction: {
      ...DEFAULT_QUALITY_THRESHOLDS.extraction,
      ...processConfig.qualityThresholds?.extraction,
      propertyCoverage: {
        ...DEFAULT_QUALITY_THRESHOLDS.extraction.propertyCoverage,
        ...processConfig.qualityThresholds?.extraction?.propertyCoverage,
      },
      orphanRate: {
        ...DEFAULT_QUALITY_THRESHOLDS.extraction.orphanRate,
        ...processConfig.qualityThresholds?.extraction?.orphanRate,
      },
      truncationRate: {
        ...DEFAULT_QUALITY_THRESHOLDS.extraction.truncationRate,
        ...processConfig.qualityThresholds?.extraction?.truncationRate,
      },
    },
    consolidation: {
      ...DEFAULT_QUALITY_THRESHOLDS.consolidation,
      ...processConfig.qualityThresholds?.consolidation,
      mergeConfidence: {
        ...DEFAULT_QUALITY_THRESHOLDS.consolidation.mergeConfidence,
        ...processConfig.qualityThresholds?.consolidation?.mergeConfidence,
      },
    },
  };

  // Build services config — the document-conversion service is present only
  // when the config declares it. Endpoint defaults to the standard docling-serve
  // host port when the section exists but omits it. Secrets take precedence over
  // any inline apiKey.
  let services: ServicesConfig | undefined;
  if (processConfig.services?.docling) {
    const raw = processConfig.services.docling;
    const docling: DoclingServiceConfig = {
      endpoint: raw.endpoint ?? 'http://localhost:5001',
      // Defaults for decision-carrying settings live here so the orchestrator
      // and the tool surface agree; the client owns only the numeric backoff
      // defaults for values the config leaves unset.
      mode: raw.mode ?? 'async',
      ocrTextYieldThreshold: raw.ocrTextYieldThreshold ?? 100,
      ...(raw.timeoutMs !== undefined ? { timeoutMs: raw.timeoutMs } : {}),
      ...(raw.maxRetries !== undefined ? { maxRetries: raw.maxRetries } : {}),
      ...(raw.doOcr !== undefined ? { doOcr: raw.doOcr } : {}),
      ...(raw.pollIntervalMs !== undefined ? { pollIntervalMs: raw.pollIntervalMs } : {}),
      ...(raw.maxPollIntervalMs !== undefined ? { maxPollIntervalMs: raw.maxPollIntervalMs } : {}),
      ...(raw.maxTotalWaitMs !== undefined ? { maxTotalWaitMs: raw.maxTotalWaitMs } : {}),
    };
    // Treat an empty-string apiKey (the secrets-template placeholder) as absent
    // so it does not send a blank X-Api-Key header.
    const apiKey = secrets.docling?.apiKey || raw.apiKey;
    if (apiKey) {
      docling.apiKey = apiKey;
    }
    services = { docling };
  }

  const config: OrchestratorConfig = {
    stateDir,
    vocabularyPath,
    extractionRulesPath,
    domainGuidancePath,
    repositoryId: processConfig.repositoryId,
    extraction,
    consolidation,
    import: processConfig.import
      ? { storage: processConfig.import.storage }
      : { storage: { type: 'sqlserver' } },
    validation,
    fullValidation,
    embeddings,
    qualityThresholds,
    ...(services ? { services } : {}),
  };

  return { config, processConfig, sourceDir };
}

/**
 * Resolve a path that may be relative to a base directory.
 */
function resolvePath(base: string, p: string): string {
  if (isAbsolute(p)) return p;
  // Handle paths relative to repo root (starting with ./)
  if (p.startsWith('./') || p.startsWith('../')) {
    // Resolve relative to the base directory's parent — these paths
    // are typically written relative to the repo root, but the processDir
    // may be nested. Use the dirname of base to go up one level if needed.
    return resolve(base, p);
  }
  return join(base, p);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
