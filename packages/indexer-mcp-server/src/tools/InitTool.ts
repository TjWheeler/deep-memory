import { mkdir, writeFile, access, readdir, copyFile } from 'node:fs/promises';
import { join, resolve, relative, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BaseToolController } from './base/BaseToolController.js';
import { ProcessStateWriter, DEFAULT_QUALITY_THRESHOLDS, IndexingOrchestrator, loadProcessConfig } from '@utaba/deep-memory-indexer';
import type { IndexProcessConfig } from '@utaba/deep-memory-indexer';

export class InitTool extends BaseToolController {
  get name() { return 'indexing_init'; }
  get description() { return 'Initialize a new indexing process directory. Creates config.json, config.secrets.json template, process-state.md, and state/ subdirectory. Run this once to set up, then use processDir with all other indexing tools.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        processDir: { type: 'string', description: 'Path to the new process directory (e.g., ./index-processes/mining-fleet)' },
        name: { type: 'string', description: 'Human-readable name for this indexing process' },
        starterKit: { type: 'string', description: 'Path to the starter kit directory (e.g., ./index-starterkits/mining)' },
        repositoryId: { type: 'string', description: 'Target deep-memory repository ID. Auto-generated UUID if omitted.' },
        sourceDir: { type: 'string', description: 'Path to the source documents directory' },
        extractionEndpoint: { type: 'string', description: 'OpenAI-compatible endpoint for the default extraction worker (e.g., http://localhost:8020/v1)' },
        extractionModel: { type: 'string', description: 'Model name for the default extraction worker (e.g., Qwen/Qwen3-4B)' },
        storageType: { type: 'string', description: 'Storage provider type for the import phase: "sqlserver", "cosmosdb", or "in-memory". Default: "sqlserver".', enum: ['sqlserver', 'cosmosdb', 'in-memory'] },
        storageConfig: { type: 'object', description: 'Storage provider connection config (e.g., host, port, database, user, password for sqlserver; endpoint, key, database, container for cosmosdb). Omit for in-memory.' },
        workers: {
          type: 'array',
          description: 'Optional worker pool configuration. If omitted, config.json is created with just the default extraction endpoint/model.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              endpoint: { type: 'string' },
              model: { type: 'string' },
              contextWindow: { type: 'number' },
              maxChunkSize: { type: 'number' },
              maxOutputTokens: { type: 'number' },
              costPerMillionInputTokens: { type: 'number' },
              costPerMillionOutputTokens: { type: 'number' },
              concurrency: { type: 'number' },
              capabilities: { type: 'array', items: { type: 'string' } },
              temperature: { type: 'number' },
              extraBodyParams: { type: 'object' },
            },
            required: ['name', 'endpoint', 'model', 'contextWindow', 'maxChunkSize', 'maxOutputTokens', 'costPerMillionInputTokens', 'costPerMillionOutputTokens', 'concurrency', 'capabilities'],
          },
        },
      },
      required: ['processDir', 'name', 'starterKit', 'sourceDir', 'extractionEndpoint', 'extractionModel'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const processDir = resolve(params['processDir'] as string);
    const name = params['name'] as string;
    const starterKit = resolve(params['starterKit'] as string);
    const repositoryId = (params['repositoryId'] as string) ?? randomUUID();
    const sourceDir = resolve(params['sourceDir'] as string);
    const extractionEndpoint = params['extractionEndpoint'] as string;
    const extractionModel = params['extractionModel'] as string;
    const workers = params['workers'] as IndexProcessConfig['extraction']['workers'] | undefined;
    const storageType = (params['storageType'] as string) ?? 'sqlserver';
    const storageConfig = params['storageConfig'] as Record<string, unknown> | undefined;

    // Check if process directory already exists
    try {
      await access(join(processDir, 'config.json'));
      return {
        message: `Process directory already initialized at ${processDir}. Delete config.json to reinitialize.`,
      };
    } catch {
      // Doesn't exist — good, we'll create it
    }

    // Create directory structure
    await mkdir(join(processDir, 'state'), { recursive: true });

    // Copy starter kit into process directory so it can be customized per-process
    const localStarterKit = join(processDir, 'starterkit');
    await mkdir(localStarterKit, { recursive: true });
    const starterKitFiles = await readdir(starterKit);
    for (const file of starterKitFiles) {
      await copyFile(join(starterKit, file), join(localStarterKit, file));
    }

    // Build fullValidation workers from extraction workers that have cost (cloud workers)
    const cloudWorkers = workers?.filter(w => w.costPerMillionInputTokens > 0) ?? [];
    const fullValidationWorkers = cloudWorkers.map(w => ({
      name: w.name,
      ...(w.llmProvider ? { llmProvider: w.llmProvider } : {}),
      ...(w.endpoint ? { endpoint: w.endpoint } : {}),
      model: w.model,
      maxBatchSize: 10,
      maxTokens: 4096,
      costPerMillionInputTokens: w.costPerMillionInputTokens,
      costPerMillionOutputTokens: w.costPerMillionOutputTokens,
      concurrency: 1,
      ...(w.extraBodyParams ? { extraBodyParams: w.extraBodyParams } : {}),
    }));

    // Build config.json — starterKit points to local copy
    const config: IndexProcessConfig = {
      name,
      starterKit: './starterkit',
      repositoryId,
      sourceDir,
      extraction: {
        endpoint: extractionEndpoint,
        model: extractionModel,
        concurrency: 1,
        maxChunkSize: 20000,
        maxTokens: 4096,
        temperature: 0,
        autoReassignFailures: workers && workers.length > 1 ? true : false,
        workers,
      },
      fullValidation: fullValidationWorkers.length > 0
        ? {
            workers: fullValidationWorkers,
            defaultWorker: fullValidationWorkers[0]!.name,
            batchSize: 10,
          }
        : undefined,
      embeddings: {
        endpoint: 'TODO: set embeddings endpoint (e.g., http://localhost:8020/v1)',
        model: 'TODO: set embeddings model',
      },
      import: {
        storage: {
          type: storageType,
          ...(storageConfig ? { config: storageConfig } : {}),
        },
      },
      // Document-conversion service for rich formats (PDF/DOCX/HTML/PPTX).
      // Only used when the source directory contains such files. Start the
      // docling-worker docker profile before running the convert action. The
      // endpoint below matches the host port the compose profile publishes.
      services: {
        docling: {
          endpoint: 'http://localhost:5001',
        },
      },
      qualityThresholds: DEFAULT_QUALITY_THRESHOLDS,
    };

    await writeFile(
      join(processDir, 'config.json'),
      JSON.stringify(config, null, 2) + '\n',
      'utf-8',
    );

    // Build config.secrets.json template
    const secretsTemplate: Record<string, unknown> = {};
    const hasCloudWorkers = workers?.some(w => w.costPerMillionInputTokens > 0);
    if (hasCloudWorkers) {
      const workerSecrets: Record<string, { apiKey: string }> = {};
      for (const w of workers!) {
        if (w.costPerMillionInputTokens > 0) {
          workerSecrets[w.name] = { apiKey: 'YOUR_API_KEY_HERE' };
        }
      }
      secretsTemplate['extraction'] = { workers: workerSecrets };
      // Validation workers reuse the same cloud workers
      secretsTemplate['validation'] = { workers: workerSecrets };
    }
    // Slot for the document-conversion service API key. Left empty — populate
    // only when docling-serve is deployed behind authentication.
    secretsTemplate['docling'] = { apiKey: '' };

    await writeFile(
      join(processDir, 'config.secrets.json'),
      JSON.stringify(secretsTemplate, null, 2) + '\n',
      'utf-8',
    );

    // Create process-state.md
    const stateWriter = new ProcessStateWriter(processDir);
    await stateWriter.initialize(name, starterKit, repositoryId);

    // Scan source directory and build inventory (prepare phase)
    const { config: orchConfig, sourceDir: resolvedSourceDir } = await loadProcessConfig(processDir);
    const orchestrator = new IndexingOrchestrator(orchConfig);
    const sourceList = await orchestrator.prepare(resolvedSourceDir);

    const files = [
      'config.json — edit extraction settings, add workers, adjust quality thresholds',
      'config.secrets.json — add API keys for cloud workers (gitignored)',
      'process-state.md — AI-maintained iteration journal',
      'state/ — pipeline state directory (auto-managed)',
      'starterkit/ — local copy of starter kit (vocabulary, guidance, extraction rules — editable per-process)',
    ];

    return {
      message: `Initialized indexing process "${name}" at ${processDir}`,
      processDir,
      files,
      sourceInventory: {
        total: sourceList.sources.length,
        sourceDir: resolvedSourceDir,
        sources: sourceList.sources.map(s => ({
          file: relative(resolvedSourceDir, s.path).replace(/\\/g, '/') || basename(s.path),
          type: s.type,
          status: s.status,
          size: s.notes,
        })),
      },
      nextSteps: [
        hasCloudWorkers
          ? 'Edit config.secrets.json to add your API keys'
          : 'config.secrets.json is empty (no cloud workers configured)',
        'Run: indexing_analyze (verbose) to review sources, workers, and cost estimates',
        'When ready, run: indexing_update phase: "extract" to advance, then indexing_execute to start extraction',
      ],
    };
  }
}
