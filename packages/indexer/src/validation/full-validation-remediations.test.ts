import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FullValidationWorker } from './FullValidationWorker.js';
import { FullValidationOrchestrator } from './FullValidationOrchestrator.js';
import type { LLMProvider, LLMToolUseTurnResult } from '../providers/LLMProvider.js';
import type {
  FullValidationWorkerConfig,
  FullValidationConfig,
  ValidationBatch,
  RelationshipBatchItem,
  CreateEntityCorrection,
  CreateRelationshipCorrection,
  RetargetRelationshipCorrection,
} from './full-validation-types.js';
import type { ExtractionOutput } from '../types/extraction.js';

function makeWorkerConfig(): FullValidationWorkerConfig {
  return {
    name: 'test-worker',
    llmProvider: 'test',
    model: 'test-model',
    maxBatchSize: 10,
    maxTokens: 4096,
    costPerMillionInputTokens: 3,
    costPerMillionOutputTokens: 15,
    concurrency: 1,
    maxToolCallsPerBatch: 5,
  };
}

function textProvider(response: unknown): LLMProvider {
  const textResult: LLMToolUseTurnResult = {
    type: 'text',
    content: JSON.stringify(response),
    usage: { inputTokens: 100, outputTokens: 40 },
    finish_reason: 'stop',
  };
  return {
    name: 'test',
    chatCompletion: vi.fn(),
    chatCompletionWithTools: vi.fn().mockResolvedValue(textResult),
  };
}

// A deferral remodel expressed with neutral domain types: a note that defers to a
// referenced document should become that document as its own entity plus a correctly
// typed edge, and the mis-carrying edge is deleted.
function deferralRemediations(sourceLabel: string, targetLabel: string) {
  return [
    {
      itemType: 'entity',
      operation: 'create',
      label: 'Section 9',
      sourceEvidence: 'the note reads "Refer to Section 9"',
      evidenceLines: { lineStart: 2, lineEnd: 2 },
      confidence: 0.8,
      entity: {
        entityType: 'Reference',
        label: 'Section 9',
        summary: 'Referenced section',
        properties: {},
        aliases: [],
        sourceRefs: [{ description: 'the deferral note', lineStart: 2, lineEnd: 2 }],
      },
    },
    {
      itemType: 'relationship',
      operation: 'create',
      label: `${sourceLabel} → [CITES] → Section 9`,
      sourceEvidence: 'the note reads "Refer to Section 9"',
      evidenceLines: { lineStart: 2, lineEnd: 2 },
      confidence: 0.8,
      relationship: {
        type: 'CITES',
        sourceLabel,
        targetLabel: 'Section 9',
        properties: {},
        sourceRefs: [{ description: 'the deferral note', lineStart: 2, lineEnd: 2 }],
      },
    },
    {
      itemType: 'relationship',
      operation: 'delete',
      label: `${sourceLabel} → [DEPENDS_ON] → ${targetLabel}`,
      sourceEvidence: 'the dependency is really a citation, not a dependency',
      evidenceLines: { lineStart: 2, lineEnd: 2 },
      confidence: 0.8,
      relationshipKey: { sourceLabel, type: 'DEPENDS_ON', targetLabel },
    },
  ];
}

// ── Worker: defensive remediation parsing ────────────────────────────────

describe('FullValidationWorker — remediation parsing', () => {
  let tmpDir: string;
  let sourceFile: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `fvr-worker-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
    sourceFile = join(tmpDir, 'doc.md');
    await writeFile(sourceFile, '# Doc\nRefer to Section 9 for details.', 'utf-8');
  });

  function relationshipBatch(): ValidationBatch {
    const item: RelationshipBatchItem = {
      type: 'relationship',
      source: 'doc.md',
      sourcePath: sourceFile,
      relationship: {
        type: 'DEPENDS_ON',
        sourceLabel: 'Item A',
        targetLabel: 'Item B',
        properties: { note: 'Refer to Section 9' },
        sourceRefs: [{ description: 'note', lineStart: 2, lineEnd: 2 }],
      },
    };
    return { batchIndex: 0, items: [item] };
  }

  function responseWithRemediations(remediations: unknown[]) {
    return {
      entities: [],
      relationships: [{
        type: 'DEPENDS_ON',
        sourceLabel: 'Item A',
        targetLabel: 'Item B',
        relationshipVerdict: 'mismatch',
        existenceVerdict: 'confirmed',
        typeVerdict: 'mismatch',
        directionalityVerdict: 'confirmed',
        properties: {},
        notes: 'The dependency is actually a citation.',
        remediations,
      }],
    };
  }

  it('parses a well-formed remediation set into typed steps', async () => {
    const worker = new FullValidationWorker(
      makeWorkerConfig(),
      textProvider(responseWithRemediations(deferralRemediations('Item A', 'Item B'))),
      [sourceFile],
    );

    const result = await worker.validateBatch(relationshipBatch());

    const steps = result.relationshipResults[0]!.remediations;
    expect(steps).toBeDefined();
    expect(steps).toHaveLength(3);
    expect(steps![0]!.operation).toBe('create');
    expect(steps![0]!.itemType).toBe('entity');
    expect(steps![1]!.operation).toBe('create');
    expect(steps![1]!.itemType).toBe('relationship');
    expect(steps![2]!.operation).toBe('delete');
    // The orchestrator-owned bookkeeping is absent on a worker step.
    expect('source' in steps![0]!).toBe(false);
    expect('remediationGroupId' in steps![0]!).toBe(false);
  });

  it('drops a malformed step with a note and keeps the batch alive', async () => {
    const remediations = deferralRemediations('Item A', 'Item B');
    // Corrupt the second step: a create with no relationship payload.
    const malformed = [
      remediations[0],
      { itemType: 'relationship', operation: 'create', label: 'x', sourceEvidence: 'x', evidenceLines: { lineStart: 1, lineEnd: 1 }, confidence: 0.5 },
      remediations[2],
    ];
    const worker = new FullValidationWorker(
      makeWorkerConfig(),
      textProvider(responseWithRemediations(malformed)),
      [sourceFile],
    );

    const result = await worker.validateBatch(relationshipBatch());

    const rel = result.relationshipResults[0]!;
    expect(rel.remediations).toHaveLength(2);
    expect(rel.notes).toContain('Dropped structural remediation');
  });

  it('drops a create step whose payload has no sourceRefs (provenance is never synthesized)', async () => {
    const remediations = deferralRemediations('Item A', 'Item B');
    const createEntity = remediations[0] as { entity: { sourceRefs: unknown[] } };
    createEntity.entity.sourceRefs = [];
    const worker = new FullValidationWorker(
      makeWorkerConfig(),
      textProvider(responseWithRemediations(remediations)),
      [sourceFile],
    );

    const result = await worker.validateBatch(relationshipBatch());

    const rel = result.relationshipResults[0]!;
    expect(rel.remediations).toHaveLength(2);
    expect(rel.notes).toContain('sourceRefs');
  });

  it('drops a step whose confidence is outside [0,1] with a note and keeps the batch alive', async () => {
    const remediations = deferralRemediations('Item A', 'Item B');
    // Corrupt two steps with out-of-range confidence values.
    (remediations[1] as { confidence: number }).confidence = 1.5;
    (remediations[2] as { confidence: number }).confidence = -0.2;
    const worker = new FullValidationWorker(
      makeWorkerConfig(),
      textProvider(responseWithRemediations(remediations)),
      [sourceFile],
    );

    const result = await worker.validateBatch(relationshipBatch());

    const rel = result.relationshipResults[0]!;
    // Only the first step (confidence 0.8) survives.
    expect(rel.remediations).toHaveLength(1);
    expect(rel.remediations![0]!.confidence).toBe(0.8);
    expect(rel.notes).toContain('confidence out of range');
  });

  it('emits no remediations field when none are proposed', async () => {
    const worker = new FullValidationWorker(
      makeWorkerConfig(),
      textProvider(responseWithRemediations([])),
      [sourceFile],
    );

    const result = await worker.validateBatch(relationshipBatch());
    expect(result.relationshipResults[0]!.remediations).toBeUndefined();
  });
});

// ── Orchestrator: buildCorrections grouping ──────────────────────────────

describe('FullValidationOrchestrator — remediation grouping', () => {
  let tmpDir: string;
  let sourceFile: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `fvr-orch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
    sourceFile = join(tmpDir, 'doc.md');
    await writeFile(sourceFile, '# Doc\nRefer to Section 9 for details.', 'utf-8');
  });

  function makeConfig(): FullValidationConfig {
    return {
      workers: [makeWorkerConfig()],
      defaultWorker: 'test-worker',
      batchSize: 10,
      maxRetries: 1,
    };
  }

  function extractionsWithRelationship(): ExtractionOutput[] {
    return [{
      source: 'doc.md',
      sourcePath: sourceFile,
      extractedAt: new Date().toISOString(),
      extractedBy: 'test',
      entities: [
        { entityType: 'Item', label: 'Item A', properties: {}, aliases: [], sourceRefs: [{ description: 'a', lineStart: 1, lineEnd: 1 }] },
        { entityType: 'Item', label: 'Item B', properties: {}, aliases: [], sourceRefs: [{ description: 'b', lineStart: 1, lineEnd: 1 }] },
      ],
      relationships: [
        { type: 'DEPENDS_ON', sourceLabel: 'Item A', targetLabel: 'Item B', properties: { note: 'Refer to Section 9' }, sourceRefs: [{ description: 'note', lineStart: 2, lineEnd: 2 }] },
      ],
    }];
  }

  function relationshipResponse(remediations: unknown[]) {
    return {
      entities: [
        { label: 'Item A', entityVerdict: 'confirmed', existenceVerdict: 'confirmed', classificationVerdict: 'confirmed', properties: {}, aliases: {} },
        { label: 'Item B', entityVerdict: 'confirmed', existenceVerdict: 'confirmed', classificationVerdict: 'confirmed', properties: {}, aliases: {} },
      ],
      relationships: [{
        type: 'DEPENDS_ON',
        sourceLabel: 'Item A',
        targetLabel: 'Item B',
        relationshipVerdict: 'mismatch',
        existenceVerdict: 'confirmed',
        typeVerdict: 'mismatch',
        directionalityVerdict: 'confirmed',
        properties: {},
        notes: 'Really a citation.',
        remediations,
      }],
    };
  }

  it('stamps a create+create+delete set into one group referencing the created entity by label', async () => {
    const orchestrator = new FullValidationOrchestrator(
      makeConfig(),
      new Map([['test', textProvider(relationshipResponse(deferralRemediations('Item A', 'Item B')))]]),
    );
    const { report } = await orchestrator.run(extractionsWithRelationship(), null, {}, {});

    const grouped = report.corrections.filter(c => c.remediationGroupId !== undefined);
    expect(grouped).toHaveLength(3);

    const groupId = grouped[0]!.remediationGroupId;
    expect(groupId).toBe('g1');
    expect(grouped.every(c => c.remediationGroupId === groupId)).toBe(true);
    // Single-source-per-group invariant holds: every member carries the item's source.
    expect(grouped.every(c => c.source === 'doc.md')).toBe(true);

    const createEntity = grouped.find(
      (c): c is CreateEntityCorrection => c.operation === 'create' && c.itemType === 'entity',
    );
    const createRel = grouped.find(
      (c): c is CreateRelationshipCorrection => c.operation === 'create' && c.itemType === 'relationship',
    );
    expect(createEntity!.entity.label).toBe('Section 9');
    // The created edge references the created entity by its label.
    expect(createRel!.relationship.targetLabel).toBe('Section 9');
    expect(grouped.some(c => c.operation === 'delete')).toBe(true);
  });

  it('stamps a wrong-endpoint proposal into a retarget correction', async () => {
    const retarget = [{
      itemType: 'relationship',
      operation: 'retarget',
      label: 'Item A → [DEPENDS_ON] → Item B',
      sourceEvidence: 'the dependency actually points at Item C',
      evidenceLines: { lineStart: 2, lineEnd: 2 },
      confidence: 0.75,
      relationshipKey: { sourceLabel: 'Item A', type: 'DEPENDS_ON', targetLabel: 'Item B' },
      endpoint: 'target',
      newLabel: 'Item C',
    }];
    const orchestrator = new FullValidationOrchestrator(
      makeConfig(),
      new Map([['test', textProvider(relationshipResponse(retarget))]]),
    );
    const { report } = await orchestrator.run(extractionsWithRelationship(), null, {}, {});

    const retargets = report.corrections.filter(
      (c): c is RetargetRelationshipCorrection => c.operation === 'retarget',
    );
    expect(retargets).toHaveLength(1);
    expect(retargets[0]!.endpoint).toBe('target');
    expect(retargets[0]!.newLabel).toBe('Item C');
    expect(retargets[0]!.remediationGroupId).toBe('g1');
  });

  it('keeps standalone field-level corrections alongside grouped remodels', async () => {
    // Response carries both a standalone property correction and a structural remodel.
    const response = {
      entities: [
        { label: 'Item A', entityVerdict: 'confirmed', existenceVerdict: 'confirmed', classificationVerdict: 'confirmed', properties: {}, aliases: {} },
        { label: 'Item B', entityVerdict: 'confirmed', existenceVerdict: 'confirmed', classificationVerdict: 'confirmed', properties: {}, aliases: {} },
      ],
      relationships: [{
        type: 'DEPENDS_ON',
        sourceLabel: 'Item A',
        targetLabel: 'Item B',
        relationshipVerdict: 'mismatch',
        existenceVerdict: 'confirmed',
        typeVerdict: 'mismatch',
        directionalityVerdict: 'confirmed',
        properties: {
          note: {
            verdict: 'corrected',
            evidence: 'note text',
            correction: {
              correctedValue: 'cited elsewhere',
              sourceEvidence: 'the note',
              evidenceLines: { lineStart: 2, lineEnd: 2 },
              confidence: 0.9,
            },
          },
        },
        notes: 'Really a citation.',
        remediations: deferralRemediations('Item A', 'Item B'),
      }],
    };

    const orchestrator = new FullValidationOrchestrator(
      makeConfig(),
      new Map([['test', textProvider(response)]]),
    );
    const { report } = await orchestrator.run(extractionsWithRelationship(), null, {}, {});

    const standalone = report.corrections.filter(c => c.remediationGroupId === undefined);
    const grouped = report.corrections.filter(c => c.remediationGroupId !== undefined);
    expect(standalone.some(c => c.operation === 'update')).toBe(true);
    expect(grouped).toHaveLength(3);
  });
});
