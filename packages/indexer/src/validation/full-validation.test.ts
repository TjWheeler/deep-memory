import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ValidationToolProvider } from './ValidationToolProvider.js';
import { FullValidationWorker } from './FullValidationWorker.js';
import { FullValidationOrchestrator } from './FullValidationOrchestrator.js';
import { estimateValidationCost } from '../orchestrator/DocumentAnalyzer.js';
import type { LLMProvider, LLMToolUseTurnResult } from '../providers/LLMProvider.js';
import type {
  FullValidationConfig,
  FullValidationWorkerConfig,
  ValidationBatch,
  EntityBatchItem,
} from './full-validation-types.js';
import type { ExtractionOutput } from '../types/extraction.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── ValidationToolProvider Tests ─────────────────────────────────────

describe('ValidationToolProvider', () => {
  let tmpDir: string;
  let sourceFile: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `vtp-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    sourceFile = join(tmpDir, 'test-source.md');
    await writeFile(sourceFile, [
      '# PC7000-11 Excavator',
      '',
      '## Specifications',
      '',
      'Operating weight: 398 MT',
      'Engine power: 1400 kW',
      '',
      '## Hydraulic System',
      '',
      'Hydraulic fluid capacity: 850 L',
      'Max pressure: 350 bar',
    ].join('\n'), 'utf-8');
  });

  it('reads specific source lines', async () => {
    const provider = new ValidationToolProvider(sourceFile, [sourceFile]);
    const result = await provider.executeTool('1', { name: 'read_source_lines', input: { lineStart: 1, lineEnd: 3 } });
    expect(result.content).toContain('PC7000-11 Excavator');
    expect(result.content).toContain('1:');
    expect(result.content).toContain('3:');
    expect(result.isError).toBeUndefined();
  });

  it('searches source for a term', async () => {
    const provider = new ValidationToolProvider(sourceFile, [sourceFile]);
    const result = await provider.executeTool('2', { name: 'search_source', input: { query: '398 MT', maxResults: 3 } });
    expect(result.content).toContain('398 MT');
    expect(result.content).toContain('Match at line');
  });

  it('returns no-match message when term not found', async () => {
    const provider = new ValidationToolProvider(sourceFile, [sourceFile]);
    const result = await provider.executeTool('3', { name: 'search_source', input: { query: 'XYZ_NOT_FOUND' } });
    expect(result.content).toContain('No matches found');
  });

  it('lists source headings', async () => {
    const provider = new ValidationToolProvider(sourceFile, [sourceFile]);
    const result = await provider.executeTool('4', { name: 'list_source_headings', input: {} });
    expect(result.content).toContain('PC7000-11 Excavator');
    expect(result.content).toContain('Specifications');
    expect(result.content).toContain('Hydraulic System');
  });

  it('reads a section by heading', async () => {
    const provider = new ValidationToolProvider(sourceFile, [sourceFile]);
    const result = await provider.executeTool('5', { name: 'read_source_section', input: { heading: 'Hydraulic' } });
    expect(result.content).toContain('850 L');
    expect(result.content).toContain('350 bar');
  });

  it('returns error message for missing section', async () => {
    const provider = new ValidationToolProvider(sourceFile, [sourceFile]);
    const result = await provider.executeTool('6', { name: 'read_source_section', input: { heading: 'NonExistent' } });
    expect(result.content).toContain('No section found');
  });

  it('reads other source document', async () => {
    const otherFile = join(tmpDir, 'other.md');
    await writeFile(otherFile, '# Other Document\n\nContent here.', 'utf-8');
    const provider = new ValidationToolProvider(sourceFile, [sourceFile, otherFile]);
    const result = await provider.executeTool('7', {
      name: 'read_other_source',
      input: { sourceFilename: 'other.md', lineStart: 1, lineEnd: 2 },
    });
    expect(result.content).toContain('Other Document');
  });

  it('returns error for unknown other source', async () => {
    const provider = new ValidationToolProvider(sourceFile, [sourceFile]);
    const result = await provider.executeTool('8', {
      name: 'read_other_source',
      input: { sourceFilename: 'nonexistent.md', lineStart: 1, lineEnd: 5 },
    });
    expect(result.content).toContain('not found');
  });

  it('handles unknown tool gracefully', async () => {
    const provider = new ValidationToolProvider(sourceFile, [sourceFile]);
    const result = await provider.executeTool('9', { name: 'unknown_tool', input: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Unknown tool');
  });

  it('returns static tool definitions', () => {
    const tools = ValidationToolProvider.getToolDefinitions();
    expect(tools).toHaveLength(5);
    const names = tools.map(t => t.name);
    expect(names).toContain('read_source_lines');
    expect(names).toContain('search_source');
    expect(names).toContain('read_source_section');
    expect(names).toContain('list_source_headings');
    expect(names).toContain('read_other_source');
  });
});

// ── FullValidationWorker Tests ────────────────────────────────────────

describe('FullValidationWorker', () => {
  let tmpDir: string;
  let sourceFile: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `fvw-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    sourceFile = join(tmpDir, 'spec-sheet.md');
    await writeFile(sourceFile, [
      '# PC7000-11 Excavator',
      'Operating weight: 398 MT',
      'Engine power: 1400 kW',
    ].join('\n'), 'utf-8');
  });

  function makeWorkerConfig(): FullValidationWorkerConfig {
    return {
      name: 'test-worker',
      llmProvider: 'test',
      model: 'test-model',
      maxBatchSize: 10,
      maxTokens: 4096,
      costPerMillionInputTokens: 15,
      costPerMillionOutputTokens: 75,
      concurrency: 1,
      maxToolCallsPerBatch: 5,
    };
  }

  function makeEntityBatch(): ValidationBatch {
    const item: EntityBatchItem = {
      type: 'entity',
      source: 'spec-sheet.md',
      sourcePath: sourceFile,
      entity: {
        entityType: 'Equipment',
        label: 'PC7000-11',
        properties: { operatingWeight: '398 MT', enginePower: '1400 kW' },
        aliases: [],
        sourceRefs: [{ description: 'Specs', lineStart: 1, lineEnd: 3 }],
      },
    };
    return { batchIndex: 0, items: [item] };
  }

  it('throws when provider does not support tool use', async () => {
    const provider: LLMProvider = {
      name: 'no-tools',
      chatCompletion: vi.fn(),
      // No chatCompletionWithTools
    };
    const worker = new FullValidationWorker(makeWorkerConfig(), provider, 'report', [sourceFile]);
    await expect(worker.validateBatch(makeEntityBatch())).rejects.toThrow(
      'does not support tool use',
    );
  });

  it('returns empty result for empty batch', async () => {
    const provider: LLMProvider = {
      name: 'test',
      chatCompletion: vi.fn(),
      chatCompletionWithTools: vi.fn(),
    };
    const worker = new FullValidationWorker(makeWorkerConfig(), provider, 'report', [sourceFile]);
    const result = await worker.validateBatch({ batchIndex: 0, items: [] });
    expect(result.entityResults).toHaveLength(0);
    expect(result.relationshipResults).toHaveLength(0);
    expect(result.toolCalls).toBe(0);
  });

  it('completes when provider returns text immediately (no tool calls)', async () => {
    const validationResponse = JSON.stringify({
      entities: [{
        label: 'PC7000-11',
        entityVerdict: 'confirmed',
        existenceVerdict: 'confirmed',
        classificationVerdict: 'confirmed',
        properties: {
          operatingWeight: { verdict: 'confirmed', evidence: 'Line 2: Operating weight: 398 MT' },
          enginePower: { verdict: 'confirmed', evidence: 'Line 3: Engine power: 1400 kW' },
        },
        aliases: {},
      }],
      relationships: [],
    });

    const textResult: LLMToolUseTurnResult = {
      type: 'text',
      content: validationResponse,
      usage: { inputTokens: 1000, outputTokens: 200 },
      finish_reason: 'stop',
    };

    const provider: LLMProvider = {
      name: 'test',
      chatCompletion: vi.fn(),
      chatCompletionWithTools: vi.fn().mockResolvedValue(textResult),
    };

    const worker = new FullValidationWorker(makeWorkerConfig(), provider, 'report', [sourceFile]);
    const result = await worker.validateBatch(makeEntityBatch());

    expect(result.entityResults).toHaveLength(1);
    expect(result.entityResults[0]!.label).toBe('PC7000-11');
    expect(result.entityResults[0]!.entityVerdict).toBe('confirmed');
    expect(result.entityResults[0]!.propertyVerdicts).toHaveLength(2);
    expect(result.usage.inputTokens).toBe(1000);
    expect(result.usage.outputTokens).toBe(200);
    expect(result.toolCalls).toBe(0);
  });

  it('handles tool call loop correctly', async () => {
    const toolCallResult: LLMToolUseTurnResult = {
      type: 'tool_use',
      toolCalls: [{ id: 'tc1', name: 'read_source_lines', input: { lineStart: 1, lineEnd: 3 } }],
      usage: { inputTokens: 500, outputTokens: 50 },
      finish_reason: 'tool_use',
    };

    const textResult: LLMToolUseTurnResult = {
      type: 'text',
      content: JSON.stringify({
        entities: [{
          label: 'PC7000-11',
          entityVerdict: 'confirmed',
          existenceVerdict: 'confirmed',
          classificationVerdict: 'confirmed',
          properties: {
            operatingWeight: { verdict: 'confirmed', evidence: 'found at line 2' },
            enginePower: { verdict: 'confirmed', evidence: 'found at line 3' },
          },
          aliases: {},
        }],
        relationships: [],
      }),
      usage: { inputTokens: 800, outputTokens: 200 },
      finish_reason: 'stop',
    };

    const provider: LLMProvider = {
      name: 'test',
      chatCompletion: vi.fn(),
      chatCompletionWithTools: vi.fn()
        .mockResolvedValueOnce(toolCallResult)
        .mockResolvedValueOnce(textResult),
    };

    const worker = new FullValidationWorker(makeWorkerConfig(), provider, 'report', [sourceFile]);
    const result = await worker.validateBatch(makeEntityBatch());

    expect(result.toolCalls).toBe(1);
    expect(result.usage.inputTokens).toBe(1300);
    expect(result.usage.outputTokens).toBe(250);
    expect(result.entityResults[0]!.entityVerdict).toBe('confirmed');
  });

  it('marks entity as unverifiable when worker returns no result', async () => {
    const textResult: LLMToolUseTurnResult = {
      type: 'text',
      content: JSON.stringify({ entities: [], relationships: [] }),
      usage: { inputTokens: 500, outputTokens: 50 },
      finish_reason: 'stop',
    };

    const provider: LLMProvider = {
      name: 'test',
      chatCompletion: vi.fn(),
      chatCompletionWithTools: vi.fn().mockResolvedValue(textResult),
    };

    const worker = new FullValidationWorker(makeWorkerConfig(), provider, 'report', [sourceFile]);
    const result = await worker.validateBatch(makeEntityBatch());

    expect(result.entityResults[0]!.entityVerdict).toBe('unverifiable');
    expect(result.entityResults[0]!.notes).toContain('did not return a result');
  });

  it('respects abort signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const provider: LLMProvider = {
      name: 'test',
      chatCompletion: vi.fn(),
      chatCompletionWithTools: vi.fn().mockRejectedValue(new Error('aborted')),
    };

    const worker = new FullValidationWorker(makeWorkerConfig(), provider, 'report', [sourceFile]);
    await expect(worker.validateBatch(makeEntityBatch(), controller.signal)).rejects.toThrow();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ── FullValidationOrchestrator Tests ─────────────────────────────────

describe('FullValidationOrchestrator', () => {
  let tmpDir: string;
  let sourceFile: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `fvo-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    sourceFile = join(tmpDir, 'doc.md');
    await writeFile(sourceFile, '# Doc\nContent here.', 'utf-8');
  });

  function makeConfig(): FullValidationConfig {
    return {
      workers: [{
        name: 'test-worker',
        llmProvider: 'test',
        model: 'test-model',
        maxTokens: 4096,
        costPerMillionInputTokens: 3,
        costPerMillionOutputTokens: 15,
        concurrency: 1,
        maxToolCallsPerBatch: 5,
      }],
      defaultWorker: 'test-worker',
      batchSize: 2,
      maxRetries: 1,
    };
  }

  function makeExtractions(): ExtractionOutput[] {
    return [{
      source: 'doc.md',
      sourcePath: sourceFile,
      extractedAt: new Date().toISOString(),
      extractedBy: 'test',
      entities: [
        { entityType: 'Equipment', label: 'PC7000', properties: { weight: '398 MT' }, aliases: [], sourceRefs: [{ description: 'specs', lineStart: 1, lineEnd: 2 }] },
        { entityType: 'Equipment', label: 'PC5500', properties: { weight: '250 MT' }, aliases: [], sourceRefs: [{ description: 'specs', lineStart: 1, lineEnd: 2 }] },
        { entityType: 'Fluid', label: 'Hydraulic Oil', properties: {}, aliases: [], sourceRefs: [{ description: 'fluids', lineStart: 1, lineEnd: 2 }] },
      ],
      relationships: [],
    }];
  }

  it('builds batches of correct size', async () => {
    const textResult: LLMToolUseTurnResult = {
      type: 'text',
      content: JSON.stringify({ entities: [], relationships: [] }),
      usage: { inputTokens: 100, outputTokens: 20 },
      finish_reason: 'stop',
    };

    const mockProvider: LLMProvider = {
      name: 'test',
      chatCompletion: vi.fn(),
      chatCompletionWithTools: vi.fn().mockResolvedValue(textResult),
    };

    const orchestrator = new FullValidationOrchestrator(makeConfig(), new Map([['test', mockProvider]]));
    const { progress } = await orchestrator.run(makeExtractions(), null, {}, {});

    // 3 entities / batchSize 2 = 2 batches
    expect(progress.batches.total).toBe(2);
    expect(progress.batches.completed).toBe(2);
    expect(progress.batches.pending).toBe(0);
  });

  it('respects maxBatches limit', async () => {
    const textResult: LLMToolUseTurnResult = {
      type: 'text',
      content: JSON.stringify({ entities: [], relationships: [] }),
      usage: { inputTokens: 100, outputTokens: 20 },
      finish_reason: 'stop',
    };

    const mockProvider: LLMProvider = {
      name: 'test',
      chatCompletion: vi.fn(),
      chatCompletionWithTools: vi.fn().mockResolvedValue(textResult),
    };

    const orchestrator = new FullValidationOrchestrator(makeConfig(), new Map([['test', mockProvider]]));
    const { progress } = await orchestrator.run(makeExtractions(), null, { maxBatches: 1 }, {});

    expect(progress.batches.completed).toBe(1);
  });

  it('skips completed batches on resume', async () => {
    const textResult: LLMToolUseTurnResult = {
      type: 'text',
      content: JSON.stringify({ entities: [], relationships: [] }),
      usage: { inputTokens: 100, outputTokens: 20 },
      finish_reason: 'stop',
    };

    const mockFn = vi.fn().mockResolvedValue(textResult);
    const mockProvider: LLMProvider = {
      name: 'test',
      chatCompletion: vi.fn(),
      chatCompletionWithTools: mockFn,
    };

    const existingProgress = {
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      worker: 'test-worker',
      totalEntities: 3,
      totalRelationships: 0,
      batches: { total: 2, completed: 1, failed: 0, pending: 1 },
      verdicts: { confirmed: 2, mismatch: 0, hallucinated: 0, unverifiable: 0, corrected: 0 },
      cost: { inputTokens: 100, outputTokens: 20, estimatedCost: 0.001 },
      batchCheckpoints: [{ batchIndex: 0, status: 'completed' as const, completedAt: new Date().toISOString(), retries: 0 }],
      validatedItemKeys: ['entity:doc.md:Equipment:PC7000', 'entity:doc.md:Equipment:PC5500'],
    };

    const orchestrator = new FullValidationOrchestrator(makeConfig(), new Map([['test', mockProvider]]));
    await orchestrator.run(makeExtractions(), existingProgress, {}, {});

    // Only 1 call (batch 1 was already complete)
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('applies source filter correctly', async () => {
    const textResult: LLMToolUseTurnResult = {
      type: 'text',
      content: JSON.stringify({ entities: [], relationships: [] }),
      usage: { inputTokens: 100, outputTokens: 20 },
      finish_reason: 'stop',
    };

    const mockFn = vi.fn().mockResolvedValue(textResult);
    const mockProvider: LLMProvider = {
      name: 'test',
      chatCompletion: vi.fn(),
      chatCompletionWithTools: mockFn,
    };

    const orchestrator = new FullValidationOrchestrator(makeConfig(), new Map([['test', mockProvider]]));
    const { progress } = await orchestrator.run(
      makeExtractions(),
      null,
      { sourceFilter: ['nonexistent-source.md'] },
      {},
    );

    // No batches — source filter matched nothing
    expect(progress.batches.total).toBe(0);
    expect(mockFn).not.toHaveBeenCalled();
  });

  it('applies entity type filter correctly', async () => {
    const textResult: LLMToolUseTurnResult = {
      type: 'text',
      content: JSON.stringify({ entities: [], relationships: [] }),
      usage: { inputTokens: 100, outputTokens: 20 },
      finish_reason: 'stop',
    };

    const mockFn = vi.fn().mockResolvedValue(textResult);
    const mockProvider: LLMProvider = {
      name: 'test',
      chatCompletion: vi.fn(),
      chatCompletionWithTools: mockFn,
    };

    const orchestrator = new FullValidationOrchestrator(makeConfig(), new Map([['test', mockProvider]]));
    const { progress } = await orchestrator.run(
      makeExtractions(),
      null,
      { entityFilter: ['Fluid'] },
      {},
    );

    // Only 1 Fluid entity / batchSize 2 = 1 batch
    expect(progress.batches.total).toBe(1);
  });

  it('emits entity:update corrections when properties have corrected values', async () => {
    const textResult: LLMToolUseTurnResult = {
      type: 'text',
      content: JSON.stringify({
        entities: [{
          label: 'PC7000',
          entityVerdict: 'corrected',
          existenceVerdict: 'confirmed',
          classificationVerdict: 'confirmed',
          properties: {
            weight: {
              verdict: 'corrected',
              evidence: 'Source says 450 MT, not 398 MT',
              correction: {
                correctedValue: '450 MT',
                sourceEvidence: 'Operating weight: 450 MT',
                evidenceLines: { lineStart: 1, lineEnd: 2 },
                confidence: 0.95,
              },
            },
          },
          aliases: {},
        }],
        relationships: [],
      }),
      usage: { inputTokens: 100, outputTokens: 20 },
      finish_reason: 'stop',
    };

    const mockProvider: LLMProvider = {
      name: 'test',
      chatCompletion: vi.fn(),
      chatCompletionWithTools: vi.fn().mockResolvedValue(textResult),
    };

    const config = makeConfig();
    config.maxBatches = 1; // Only need the first batch — PC7000 is first
    const orchestrator = new FullValidationOrchestrator(config, new Map([['test', mockProvider]]));
    const { report } = await orchestrator.run(makeExtractions(), null, {}, {});

    const entityUpdates = report.corrections.filter(c => c.itemType === 'entity' && c.operation === 'update');
    expect(entityUpdates).toHaveLength(1);
    expect(entityUpdates[0]!.label).toBe('PC7000');
    expect(entityUpdates[0]!.property).toBe('weight');
    expect(entityUpdates[0]!.correctedValue).toBe('450 MT');
    expect(entityUpdates[0]!.confidence).toBe(0.95);
  });

  it('emits remove-property corrections when correctedValue is null', async () => {
    const textResult: LLMToolUseTurnResult = {
      type: 'text',
      content: JSON.stringify({
        entities: [{
          label: 'PC7000',
          entityVerdict: 'corrected',
          existenceVerdict: 'confirmed',
          classificationVerdict: 'confirmed',
          properties: {
            weight: {
              verdict: 'corrected',
              evidence: 'Source has no weight value for this entity',
              correction: {
                correctedValue: null,
                sourceEvidence: 'No weight listed',
                evidenceLines: { lineStart: 1, lineEnd: 1 },
                confidence: 0.9,
              },
            },
          },
          aliases: {},
        }],
        relationships: [],
      }),
      usage: { inputTokens: 100, outputTokens: 20 },
      finish_reason: 'stop',
    };

    const mockProvider: LLMProvider = {
      name: 'test',
      chatCompletion: vi.fn(),
      chatCompletionWithTools: vi.fn().mockResolvedValue(textResult),
    };

    const config = makeConfig();
    config.maxBatches = 1;
    const orchestrator = new FullValidationOrchestrator(config, new Map([['test', mockProvider]]));
    const { report } = await orchestrator.run(makeExtractions(), null, {}, {});

    const removals = report.corrections.filter(c => c.operation === 'remove-property');
    expect(removals).toHaveLength(1);
    expect(removals[0]!.itemType).toBe('entity');
    expect(removals[0]!.property).toBe('weight');
    expect(removals[0]!.correctedValue).toBeUndefined();
  });

  it('emits entity:delete corrections for hallucinated entities', async () => {
    const textResult: LLMToolUseTurnResult = {
      type: 'text',
      content: JSON.stringify({
        entities: [{
          label: 'PC7000',
          entityVerdict: 'hallucinated',
          existenceVerdict: 'hallucinated',
          classificationVerdict: 'unverifiable',
          properties: {
            weight: { verdict: 'hallucinated', evidence: 'Entity not in source' },
          },
          aliases: {},
          notes: 'This entity is not mentioned anywhere in the source document.',
        }],
        relationships: [],
      }),
      usage: { inputTokens: 100, outputTokens: 20 },
      finish_reason: 'stop',
    };

    const mockProvider: LLMProvider = {
      name: 'test',
      chatCompletion: vi.fn(),
      chatCompletionWithTools: vi.fn().mockResolvedValue(textResult),
    };

    const config = makeConfig();
    config.maxBatches = 1;
    const orchestrator = new FullValidationOrchestrator(config, new Map([['test', mockProvider]]));
    const { report } = await orchestrator.run(makeExtractions(), null, {}, {});

    const deletes = report.corrections.filter(c => c.operation === 'delete' && c.itemType === 'entity');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.label).toBe('PC7000');
    expect(deletes[0]!.property).toBeUndefined();
    expect(deletes[0]!.sourceEvidence).toContain('not mentioned');
  });

  it('emits relationship:update and relationship:delete corrections', async () => {
    const extractionsWithRel: ExtractionOutput[] = [{
      source: 'doc.md',
      sourcePath: sourceFile,
      extractedAt: new Date().toISOString(),
      extractedBy: 'test',
      entities: [
        { entityType: 'Equipment', label: 'PC7000', properties: {}, aliases: [], sourceRefs: [{ description: 'specs', lineStart: 1, lineEnd: 2 }] },
        { entityType: 'Manufacturer', label: 'Komatsu', properties: {}, aliases: [], sourceRefs: [{ description: 'specs', lineStart: 1, lineEnd: 2 }] },
      ],
      relationships: [
        {
          type: 'MANUFACTURED_BY',
          sourceLabel: 'PC7000',
          targetLabel: 'Komatsu',
          properties: { year: '2010' },
          sourceRefs: [{ description: 'specs', lineStart: 1, lineEnd: 2 }],
        },
        {
          type: 'COMPATIBLE_WITH',
          sourceLabel: 'PC7000',
          targetLabel: 'Komatsu',
          properties: {},
          sourceRefs: [{ description: 'specs', lineStart: 1, lineEnd: 2 }],
        },
      ],
    }];

    const textResult: LLMToolUseTurnResult = {
      type: 'text',
      content: JSON.stringify({
        entities: [],
        relationships: [
          {
            type: 'MANUFACTURED_BY',
            sourceLabel: 'PC7000',
            targetLabel: 'Komatsu',
            relationshipVerdict: 'corrected',
            existenceVerdict: 'confirmed',
            typeVerdict: 'confirmed',
            directionalityVerdict: 'confirmed',
            properties: {
              year: {
                verdict: 'corrected',
                evidence: 'Source says 2012, not 2010',
                correction: {
                  correctedValue: '2012',
                  sourceEvidence: 'Introduced 2012',
                  evidenceLines: { lineStart: 1, lineEnd: 1 },
                  confidence: 0.9,
                },
              },
            },
          },
          {
            type: 'COMPATIBLE_WITH',
            sourceLabel: 'PC7000',
            targetLabel: 'Komatsu',
            relationshipVerdict: 'hallucinated',
            existenceVerdict: 'hallucinated',
            typeVerdict: 'unverifiable',
            directionalityVerdict: 'unverifiable',
            properties: {},
            notes: 'No COMPATIBLE_WITH mention in source',
          },
        ],
      }),
      usage: { inputTokens: 100, outputTokens: 20 },
      finish_reason: 'stop',
    };

    const mockProvider: LLMProvider = {
      name: 'test',
      chatCompletion: vi.fn(),
      chatCompletionWithTools: vi.fn().mockResolvedValue(textResult),
    };

    const orchestrator = new FullValidationOrchestrator(makeConfig(), new Map([['test', mockProvider]]));
    const { report } = await orchestrator.run(extractionsWithRel, null, {}, {});

    const relUpdates = report.corrections.filter(c => c.itemType === 'relationship' && c.operation === 'update');
    expect(relUpdates).toHaveLength(1);
    expect(relUpdates[0]!.relationshipKey).toEqual({
      sourceLabel: 'PC7000',
      type: 'MANUFACTURED_BY',
      targetLabel: 'Komatsu',
    });
    expect(relUpdates[0]!.property).toBe('year');
    expect(relUpdates[0]!.correctedValue).toBe('2012');

    const relDeletes = report.corrections.filter(c => c.itemType === 'relationship' && c.operation === 'delete');
    expect(relDeletes).toHaveLength(1);
    expect(relDeletes[0]!.relationshipKey).toEqual({
      sourceLabel: 'PC7000',
      type: 'COMPATIBLE_WITH',
      targetLabel: 'Komatsu',
    });
  });

  it('tracks cost correctly', async () => {
    const textResult: LLMToolUseTurnResult = {
      type: 'text',
      content: JSON.stringify({ entities: [], relationships: [] }),
      usage: { inputTokens: 1000, outputTokens: 200 },
      finish_reason: 'stop',
    };

    const mockProvider: LLMProvider = {
      name: 'test',
      chatCompletion: vi.fn(),
      chatCompletionWithTools: vi.fn().mockResolvedValue(textResult),
    };

    const orchestrator = new FullValidationOrchestrator(makeConfig(), new Map([['test', mockProvider]]));
    const { progress } = await orchestrator.run(makeExtractions(), null, {}, {});

    // 2 batches * 1000 input + 200 output per batch
    expect(progress.cost.inputTokens).toBe(2000);
    expect(progress.cost.outputTokens).toBe(400);
    // Cost: (2000/1M)*3 + (400/1M)*15 = 0.006 + 0.006 = 0.012
    expect(progress.cost.estimatedCost).toBeCloseTo(0.012, 5);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ── estimateValidationCost Tests ──────────────────────────────────────

describe('estimateValidationCost', () => {
  function makeConfig(workers: Partial<FullValidationWorkerConfig>[] = []): FullValidationConfig {
    const defaultWorker: FullValidationWorkerConfig = {
      name: 'cloud-opus',
      llmProvider: 'anthropic',
      model: 'claude-opus-4-6',
      maxBatchSize: 10,
      maxTokens: 16384,
      costPerMillionInputTokens: 15,
      costPerMillionOutputTokens: 75,
      concurrency: 2,
    };
    return {
      workers: workers.length > 0
        ? workers.map(w => ({ ...defaultWorker, ...w }))
        : [defaultWorker],
      defaultWorker: 'cloud-opus',
      batchSize: 10,
    };
  }

  it('computes batch count from entity/relationship count and batchSize', () => {
    const estimate = estimateValidationCost(100, 200, makeConfig());
    expect(estimate.totalEntities).toBe(100);
    expect(estimate.totalRelationships).toBe(200);
    // (100 + 200) / 10 = 30 batches
    expect(estimate.totalBatches).toBe(30);
  });

  it('includes cost entry for each worker', () => {
    const config = makeConfig([
      { name: 'opus', costPerMillionInputTokens: 15, costPerMillionOutputTokens: 75 },
      { name: 'sonnet', costPerMillionInputTokens: 3, costPerMillionOutputTokens: 15 },
    ]);
    const estimate = estimateValidationCost(100, 100, config);
    expect(estimate.costByWorker['opus']).toBeDefined();
    expect(estimate.costByWorker['sonnet']).toBeDefined();
  });

  it('sonnet costs less than opus for same workload', () => {
    const config = makeConfig([
      { name: 'opus', costPerMillionInputTokens: 15, costPerMillionOutputTokens: 75 },
      { name: 'sonnet', costPerMillionInputTokens: 3, costPerMillionOutputTokens: 15 },
    ]);
    const estimate = estimateValidationCost(500, 500, config);
    const opusCost = parseFloat(estimate.costByWorker['opus']!.replace('$', ''));
    const sonnetCost = parseFloat(estimate.costByWorker['sonnet']!.replace('$', ''));
    expect(opusCost).toBeGreaterThan(sonnetCost);
  });

  it('computes hybrid estimate when hybrid config is present', () => {
    const config: FullValidationConfig = {
      workers: [
        { name: 'sonnet', llmProvider: 'anthropic', model: 'claude-sonnet-4-6', maxBatchSize: 10, maxTokens: 8192, costPerMillionInputTokens: 3, costPerMillionOutputTokens: 15, concurrency: 3 },
        { name: 'opus', llmProvider: 'anthropic', model: 'claude-opus-4-6', maxBatchSize: 10, maxTokens: 16384, costPerMillionInputTokens: 15, costPerMillionOutputTokens: 75, concurrency: 2 },
      ],
      defaultWorker: 'sonnet',
      batchSize: 10,
      hybrid: { firstPass: 'sonnet', escalation: 'opus', escalateOn: ['mismatch', 'hallucinated'] },
    };
    const estimate = estimateValidationCost(500, 500, config);
    const hybridKey = Object.keys(estimate.costByWorker).find(k => k.includes('hybrid'));
    expect(hybridKey).toBeDefined();
  });

  it('handles zero entities/relationships gracefully', () => {
    const estimate = estimateValidationCost(0, 0, makeConfig());
    expect(estimate.totalBatches).toBe(0);
    expect(estimate.estimatedInputTokens).toBe(0);
    expect(estimate.estimatedOutputTokens).toBe(0);
  });
});
