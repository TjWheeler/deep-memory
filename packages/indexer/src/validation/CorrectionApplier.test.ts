import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  MemoryVocabulary,
  EntityTypeDefinition,
  RelationshipTypeDefinition,
  PropertySchema,
  GovernanceMode,
} from '@utaba/deep-memory';
import { StateManager } from '../orchestrator/StateManager.js';
import type { ExtractedEntity, ExtractedRelationship, SourceRef } from '../types/extraction.js';
import { CorrectionApplier } from './CorrectionApplier.js';
import type { ProposedCorrection } from './full-validation-types.js';

const NOW = '2026-07-19T00:00:00Z';
const EVIDENCE = { sourceEvidence: 'source text', evidenceLines: { lineStart: 1, lineEnd: 2 } };
const REFS: SourceRef[] = [{ description: 'clause body', lineStart: 10, lineEnd: 12 }];

// ── Vocabulary fixture (council-shaped, but the engine never names these) ──

function entityType(type: string, properties: PropertySchema[] = []): EntityTypeDefinition {
  return {
    type,
    description: `${type} test type`,
    version: '1.0.0',
    properties,
    createdAt: NOW,
    createdBy: 'test',
    modifiedAt: NOW,
    modifiedBy: 'test',
  };
}

function relationshipType(
  type: string,
  allowedSourceTypes: string[],
  allowedTargetTypes: string[],
  properties: PropertySchema[] = [],
): RelationshipTypeDefinition {
  return {
    type,
    description: `${type} test type`,
    version: '1.0.0',
    allowedSourceTypes,
    allowedTargetTypes,
    bidirectional: false,
    properties,
    createdAt: NOW,
    createdBy: 'test',
    modifiedAt: NOW,
    modifiedBy: 'test',
  };
}

function buildVocabulary(): MemoryVocabulary {
  return {
    version: '1.0.0',
    lastModified: NOW,
    modifiedBy: 'test',
    entityTypes: [
      entityType('Zone'),
      entityType('LandUse'),
      entityType('Provision', [
        { name: 'category', type: 'enum', required: false, enumValues: ['A', 'B'] },
        { name: 'weight', type: 'number', required: false },
      ]),
    ],
    relationshipTypes: [
      relationshipType('PERMITS', ['Zone'], ['LandUse'], [
        { name: 'permissibility', type: 'enum', required: true, enumValues: ['P', 'D', 'A', 'X'] },
      ]),
      relationshipType('APPLIES_IN', ['Provision'], ['Zone']),
      relationshipType('RESTRICTS', ['Provision'], ['LandUse']),
    ],
  };
}

// ── Extraction fixture builders ────────────────────────────────────────

function ent(entityType: string, label: string, properties: Record<string, unknown> = {}): ExtractedEntity {
  return { entityType, label, properties, aliases: [], sourceRefs: REFS };
}

function rel(
  type: string,
  sourceLabel: string,
  targetLabel: string,
  properties: Record<string, unknown> = {},
): ExtractedRelationship {
  return { type, sourceLabel, targetLabel, properties, sourceRefs: REFS };
}

const SELECTED_EXTRACTION = 'extraction-notes/w/doc.json';

interface FileShape {
  entities: Array<ExtractedEntity & Record<string, unknown>>;
  relationships: Array<ExtractedRelationship & Record<string, unknown>>;
}

describe('CorrectionApplier', () => {
  let stateDir: string;
  let state: StateManager;

  async function seed(opts: {
    entities?: ExtractedEntity[];
    relationships?: ExtractedRelationship[];
    corrections: ProposedCorrection[];
  }): Promise<void> {
    await state.saveSourceList({
      version: '1.0.0',
      repositoryId: 'repo',
      sources: [{ path: 'doc.md', type: 'doc', status: 'validated', selectedExtraction: SELECTED_EXTRACTION }],
    });
    await mkdir(join(stateDir, 'extraction-notes', 'w'), { recursive: true });
    await writeFile(
      join(stateDir, SELECTED_EXTRACTION),
      JSON.stringify(
        {
          source: 'doc.md',
          sourcePath: '/corpus/doc.md',
          extractedAt: NOW,
          extractedBy: 'w',
          entities: opts.entities ?? [],
          relationships: opts.relationships ?? [],
        },
        null,
        2,
      ),
    );
    await state.saveFullValidationCorrections(opts.corrections);
  }

  async function readFileShape(): Promise<FileShape> {
    const raw = await readFile(join(stateDir, SELECTED_EXTRACTION), 'utf-8');
    return JSON.parse(raw) as FileShape;
  }

  function applier(mode: GovernanceMode = 'managed'): CorrectionApplier {
    return new CorrectionApplier(state, buildVocabulary(), mode);
  }

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'correction-applier-'));
    state = new StateManager(stateDir);
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  // ── Selection / envelope outcomes ───────────────────────────────────

  it('reports no-corrections when nothing has been proposed', async () => {
    await seed({ corrections: [] });
    const result = await applier().apply({ selection: { approveAll: true }, dryRun: false });
    expect(result.outcome).toBe('no-corrections');
  });

  it('returns a per-member-narrowed listing when no selection is given', async () => {
    await seed({
      entities: [ent('Zone', 'RZ'), ent('LandUse', 'Shop'), ent('Provision', 'Clause 1')],
      relationships: [rel('PERMITS', 'RZ', 'Shop', { permissibility: 'P' })],
      corrections: [
        { itemType: 'entity', operation: 'update', source: 'doc.md', label: 'RZ', property: 'name', originalValue: 'x', correctedValue: 'y', confidence: 0.9, ...EVIDENCE },
        {
          itemType: 'entity', operation: 'create', source: 'doc.md', label: 'Clause 2', confidence: 0.9, ...EVIDENCE,
          entity: ent('Provision', 'Clause 2'),
        },
        {
          itemType: 'relationship', operation: 'retarget', source: 'doc.md', label: 'edge', confidence: 0.9, ...EVIDENCE,
          relationshipKey: { sourceLabel: 'RZ', type: 'PERMITS', targetLabel: 'Shop' }, endpoint: 'source', newLabel: 'RZ2',
        },
      ],
    });
    const result = await applier().apply({ selection: {}, dryRun: true });
    expect(result.outcome).toBe('no-selection');
    expect(result.byOperation).toMatchObject({ 'entity:update': 1, 'entity:create': 1, 'relationship:retarget': 1 });
    const listing = result.listing!;
    expect(listing[0]).toMatchObject({ property: 'name', correctedValue: 'y' });
    expect(listing[1]).toMatchObject({ entityType: 'Provision', propertyCount: 0 });
    expect(listing[2]!.retarget).toContain('⇒');
  });

  it('reports no-matches when a selection resolves to nothing', async () => {
    await seed({
      entities: [ent('Zone', 'RZ')],
      corrections: [
        { itemType: 'entity', operation: 'update', source: 'doc.md', label: 'RZ', property: 'p', correctedValue: 1, confidence: 0.5, ...EVIDENCE },
      ],
    });
    const result = await applier().apply({ selection: { approveAll: true, minConfidence: 0.8 }, dryRun: false });
    expect(result.outcome).toBe('no-matches');
  });

  // ── Ported operations ───────────────────────────────────────────────

  it('applies entity update and remove-property, and writes a backup', async () => {
    await seed({
      entities: [ent('Zone', 'RZ', { keep: 'v', drop: 'gone' })],
      corrections: [
        { itemType: 'entity', operation: 'update', source: 'doc.md', label: 'RZ', property: 'keep', originalValue: 'v', correctedValue: 'v2', confidence: 0.9, ...EVIDENCE },
        { itemType: 'entity', operation: 'remove-property', source: 'doc.md', label: 'RZ', property: 'drop', confidence: 0.9, ...EVIDENCE },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0, 1] }, dryRun: false });
    expect(result.outcome).toBe('applied');
    expect(result.applied).toHaveLength(2);

    const file = await readFileShape();
    expect(file.entities[0]!.properties).toEqual({ keep: 'v2' });

    // A timestamped backup of the original file was written.
    expect(result.backupLocation).toBeTruthy();
    const backupFile = join(result.backupLocation!, SELECTED_EXTRACTION);
    const backup = JSON.parse(await readFile(backupFile, 'utf-8')) as FileShape;
    expect(backup.entities[0]!.properties).toEqual({ keep: 'v', drop: 'gone' });
  });

  it('deletes an entity and cascades its relationships', async () => {
    await seed({
      entities: [ent('Zone', 'RZ'), ent('LandUse', 'Shop')],
      relationships: [rel('PERMITS', 'RZ', 'Shop', { permissibility: 'P' })],
      corrections: [
        { itemType: 'entity', operation: 'delete', source: 'doc.md', label: 'RZ', confidence: 0.9, ...EVIDENCE },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0] }, dryRun: false });
    expect(result.applied).toHaveLength(1);
    expect(result.cascaded).toHaveLength(1);
    const file = await readFileShape();
    expect(file.entities.map(e => e.label)).toEqual(['Shop']);
    expect(file.relationships).toHaveLength(0);
  });

  it('applies relationship update / remove-property / delete by key', async () => {
    await seed({
      entities: [ent('Zone', 'RZ'), ent('LandUse', 'Shop')],
      relationships: [
        rel('PERMITS', 'RZ', 'Shop', { permissibility: 'P', note: 'x' }),
        rel('APPLIES_IN', 'RZ', 'Shop', {}),
      ],
      corrections: [
        { itemType: 'relationship', operation: 'update', source: 'doc.md', label: 'e', property: 'permissibility', correctedValue: 'D', confidence: 0.9, ...EVIDENCE, relationshipKey: { sourceLabel: 'RZ', type: 'PERMITS', targetLabel: 'Shop' } },
        { itemType: 'relationship', operation: 'remove-property', source: 'doc.md', label: 'e', property: 'note', confidence: 0.9, ...EVIDENCE, relationshipKey: { sourceLabel: 'RZ', type: 'PERMITS', targetLabel: 'Shop' } },
        { itemType: 'relationship', operation: 'delete', source: 'doc.md', label: 'e2', confidence: 0.9, ...EVIDENCE, relationshipKey: { sourceLabel: 'RZ', type: 'APPLIES_IN', targetLabel: 'Shop' } },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0, 1, 2] }, dryRun: false });
    expect(result.applied).toHaveLength(3);
    const file = await readFileShape();
    expect(file.relationships).toHaveLength(1);
    expect(file.relationships[0]!.properties).toEqual({ permissibility: 'D' });
  });

  it('skips a not-found match rather than failing', async () => {
    await seed({
      entities: [ent('Zone', 'RZ')],
      corrections: [
        { itemType: 'entity', operation: 'update', source: 'doc.md', label: 'Ghost', property: 'p', correctedValue: 1, confidence: 0.9, ...EVIDENCE },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0] }, dryRun: false });
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped![0]!.reason).toContain('not found');
  });

  it('does not write anything on a dry run', async () => {
    await seed({
      entities: [ent('Zone', 'RZ', { p: 'orig' })],
      corrections: [
        { itemType: 'entity', operation: 'update', source: 'doc.md', label: 'RZ', property: 'p', correctedValue: 'new', confidence: 0.9, ...EVIDENCE },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0] }, dryRun: true });
    expect(result.outcome).toBe('dry-run');
    expect(result.plan).toHaveLength(1);
    const file = await readFileShape();
    expect(file.entities[0]!.properties).toEqual({ p: 'orig' });
  });

  // ── Create ──────────────────────────────────────────────────────────

  it('creates a new entity (happy path)', async () => {
    await seed({
      entities: [ent('Zone', 'RZ')],
      corrections: [
        { itemType: 'entity', operation: 'create', source: 'doc.md', label: 'Clause 3.3.6', confidence: 0.9, ...EVIDENCE, entity: ent('Provision', 'Clause 3.3.6') },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0] }, dryRun: false });
    expect(result.created).toHaveLength(1);
    const file = await readFileShape();
    expect(file.entities.some(e => e.label === 'Clause 3.3.6' && e.entityType === 'Provision')).toBe(true);
  });

  it('treats a same-type label collision as an already-exists success without duplicating', async () => {
    await seed({
      entities: [ent('Provision', 'Clause 3.3.6')],
      corrections: [
        { itemType: 'entity', operation: 'create', source: 'doc.md', label: 'clause 3.3.6', confidence: 0.9, ...EVIDENCE, entity: ent('Provision', 'clause 3.3.6', { category: 'A' }) },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0] }, dryRun: false });
    expect(result.created ?? []).toHaveLength(0);
    expect(result.skipped![0]!.kind).toBe('already-exists');
    const file = await readFileShape();
    expect(file.entities).toHaveLength(1);
    // Not merged: the existing entity keeps its (empty) properties.
    expect(file.entities[0]!.properties).toEqual({});
  });

  it('fails a create whose entity has no sourceRefs', async () => {
    await seed({
      entities: [],
      corrections: [
        { itemType: 'entity', operation: 'create', source: 'doc.md', label: 'P', confidence: 0.9, ...EVIDENCE, entity: { entityType: 'Provision', label: 'P', properties: {}, aliases: [], sourceRefs: [] } },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0] }, dryRun: false });
    expect(result.failed).toHaveLength(1);
    expect(result.failed![0]!.error).toContain('sourceRefs');
  });

  // ── Apply-side conformance ──────────────────────────────────────────

  it('fails an unknown entity type under managed but warns under open', async () => {
    const corrections: ProposedCorrection[] = [
      { itemType: 'entity', operation: 'create', source: 'doc.md', label: 'G', confidence: 0.9, ...EVIDENCE, entity: ent('Ghost', 'G') },
    ];
    await seed({ corrections });
    const managed = await applier('managed').apply({ selection: { approvedIndices: [0] }, dryRun: false });
    expect(managed.failed).toHaveLength(1);
    expect(managed.failed![0]!.error).toContain('vocabulary extension');

    // Reset corrections (managed run marked index 0 approved) and re-run under open.
    await state.saveFullValidationCorrections(corrections);
    const open = await applier('open').apply({ selection: { approvedIndices: [0] }, dryRun: false });
    expect(open.created).toHaveLength(1);
    expect(open.warnings![0]!.warning).toBe('unknown-type-admitted');
  });

  it('fails a create that violates a closed enum', async () => {
    await seed({
      entities: [ent('Zone', 'RZ'), ent('LandUse', 'Shop')],
      corrections: [
        { itemType: 'relationship', operation: 'create', source: 'doc.md', label: 'e', confidence: 0.9, ...EVIDENCE, relationship: rel('PERMITS', 'RZ', 'Shop', { permissibility: 'Z' }) },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0] }, dryRun: false });
    expect(result.failed).toHaveLength(1);
  });

  it('fails a relationship create missing a required property', async () => {
    await seed({
      entities: [ent('Zone', 'RZ'), ent('LandUse', 'Shop')],
      corrections: [
        { itemType: 'relationship', operation: 'create', source: 'doc.md', label: 'e', confidence: 0.9, ...EVIDENCE, relationship: rel('PERMITS', 'RZ', 'Shop', {}) },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0] }, dryRun: false });
    expect(result.failed).toHaveLength(1);
  });

  it('fails a relationship create that violates endpoint types', async () => {
    await seed({
      entities: [ent('Provision', 'P'), ent('LandUse', 'Shop')],
      corrections: [
        // PERMITS requires a Zone source; a Provision is not allowed.
        { itemType: 'relationship', operation: 'create', source: 'doc.md', label: 'e', confidence: 0.9, ...EVIDENCE, relationship: rel('PERMITS', 'P', 'Shop', { permissibility: 'P' }) },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0] }, dryRun: false });
    expect(result.failed).toHaveLength(1);
  });

  it('fails a retarget that violates endpoint types', async () => {
    await seed({
      entities: [ent('Zone', 'RZ'), ent('LandUse', 'Shop'), ent('Provision', 'P')],
      relationships: [rel('PERMITS', 'RZ', 'Shop', { permissibility: 'P' })],
      corrections: [
        // Moving the PERMITS source onto a Provision breaks allowedSourceTypes.
        { itemType: 'relationship', operation: 'retarget', source: 'doc.md', label: 'e', confidence: 0.9, ...EVIDENCE, relationshipKey: { sourceLabel: 'RZ', type: 'PERMITS', targetLabel: 'Shop' }, endpoint: 'source', newLabel: 'P' },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0] }, dryRun: false });
    expect(result.failed).toHaveLength(1);
    const file = await readFileShape();
    expect(file.relationships[0]!.sourceLabel).toBe('RZ'); // unchanged
  });

  // ── Retarget variants ───────────────────────────────────────────────

  it('retargets the source endpoint', async () => {
    await seed({
      entities: [ent('Provision', 'Old'), ent('Provision', 'New'), ent('Zone', 'RZ')],
      relationships: [rel('APPLIES_IN', 'Old', 'RZ', {})],
      corrections: [
        { itemType: 'relationship', operation: 'retarget', source: 'doc.md', label: 'e', confidence: 0.9, ...EVIDENCE, relationshipKey: { sourceLabel: 'Old', type: 'APPLIES_IN', targetLabel: 'RZ' }, endpoint: 'source', newLabel: 'New' },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0] }, dryRun: false });
    expect(result.retargeted).toHaveLength(1);
    const file = await readFileShape();
    expect(file.relationships[0]!.sourceLabel).toBe('New');
  });

  it('retargets the target endpoint', async () => {
    await seed({
      entities: [ent('Provision', 'P'), ent('Zone', 'RZ'), ent('Zone', 'RZ2')],
      relationships: [rel('APPLIES_IN', 'P', 'RZ', {})],
      corrections: [
        { itemType: 'relationship', operation: 'retarget', source: 'doc.md', label: 'e', confidence: 0.9, ...EVIDENCE, relationshipKey: { sourceLabel: 'P', type: 'APPLIES_IN', targetLabel: 'RZ' }, endpoint: 'target', newLabel: 'RZ2' },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0] }, dryRun: false });
    expect(result.retargeted).toHaveLength(1);
    const file = await readFileShape();
    expect(file.relationships[0]!.targetLabel).toBe('RZ2');
  });

  it('deduplicates a retarget into an existing edge', async () => {
    await seed({
      entities: [ent('Provision', 'Old'), ent('Provision', 'New'), ent('Zone', 'RZ')],
      relationships: [rel('APPLIES_IN', 'Old', 'RZ', {}), rel('APPLIES_IN', 'New', 'RZ', {})],
      corrections: [
        { itemType: 'relationship', operation: 'retarget', source: 'doc.md', label: 'e', confidence: 0.9, ...EVIDENCE, relationshipKey: { sourceLabel: 'Old', type: 'APPLIES_IN', targetLabel: 'RZ' }, endpoint: 'source', newLabel: 'New' },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0] }, dryRun: false });
    expect(result.retargeted![0]!.deduplicated).toBe(true);
    const file = await readFileShape();
    expect(file.relationships).toHaveLength(1);
    expect(file.relationships[0]!.sourceLabel).toBe('New');
  });

  // ── Groups ──────────────────────────────────────────────────────────

  it('applies a group create+create referencing an endpoint created earlier in the group', async () => {
    await seed({
      entities: [ent('Zone', 'RZ')],
      corrections: [
        { itemType: 'entity', operation: 'create', source: 'doc.md', label: 'Clause X', remediationGroupId: 'g1', confidence: 0.9, ...EVIDENCE, entity: ent('Provision', 'Clause X') },
        { itemType: 'relationship', operation: 'create', source: 'doc.md', label: 'e', remediationGroupId: 'g1', confidence: 0.9, ...EVIDENCE, relationship: rel('APPLIES_IN', 'Clause X', 'RZ', {}) },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0, 1] }, dryRun: false });
    expect(result.skippedGroups ?? []).toHaveLength(0);
    const file = await readFileShape();
    expect(file.entities.some(e => e.label === 'Clause X')).toBe(true);
    expect(file.relationships.some(r => r.type === 'APPLIES_IN' && r.sourceLabel === 'Clause X')).toBe(true);
  });

  it('retargets onto an entity created earlier in the same group', async () => {
    await seed({
      entities: [ent('Provision', 'Old'), ent('Zone', 'RZ')],
      relationships: [rel('APPLIES_IN', 'Old', 'RZ', {})],
      corrections: [
        { itemType: 'entity', operation: 'create', source: 'doc.md', label: 'Clause Y', remediationGroupId: 'g1', confidence: 0.9, ...EVIDENCE, entity: ent('Provision', 'Clause Y') },
        { itemType: 'relationship', operation: 'retarget', source: 'doc.md', label: 'e', remediationGroupId: 'g1', confidence: 0.9, ...EVIDENCE, relationshipKey: { sourceLabel: 'Old', type: 'APPLIES_IN', targetLabel: 'RZ' }, endpoint: 'source', newLabel: 'Clause Y' },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0, 1] }, dryRun: false });
    expect(result.skippedGroups ?? []).toHaveLength(0);
    const file = await readFileShape();
    expect(file.relationships[0]!.sourceLabel).toBe('Clause Y');
  });

  it('aborts a whole group on a cross-type collision, applying nothing', async () => {
    await seed({
      entities: [ent('Provision', 'Clause 3.3.6'), ent('Zone', 'RZ')],
      corrections: [
        { itemType: 'entity', operation: 'create', source: 'doc.md', label: 'New Prov', remediationGroupId: 'g1', confidence: 0.9, ...EVIDENCE, entity: ent('Provision', 'New Prov') },
        // Cross-type collision: "Clause 3.3.6" already exists as a Provision.
        { itemType: 'entity', operation: 'create', source: 'doc.md', label: 'Clause 3.3.6', remediationGroupId: 'g1', confidence: 0.9, ...EVIDENCE, entity: ent('Zone', 'Clause 3.3.6') },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0, 1] }, dryRun: false });
    expect(result.skippedGroups).toHaveLength(1);
    expect(result.skippedGroups![0]!.reason).toContain('group-aborted');
    expect(result.skippedGroups![0]!.memberIndices).toEqual([0, 1]);
    const file = await readFileShape();
    // "New Prov" must NOT have been created — the group applied nothing.
    expect(file.entities.some(e => e.label === 'New Prov')).toBe(false);
  });

  it('applies group members in precedence order so a retargeted edge survives a delete cascade', async () => {
    await seed({
      entities: [ent('Zone', 'Artifact'), ent('Zone', 'RZ'), ent('LandUse', 'Shop'), ent('LandUse', 'Cafe')],
      relationships: [
        rel('PERMITS', 'Artifact', 'Shop', { permissibility: 'P' }),
        rel('PERMITS', 'Artifact', 'Cafe', { permissibility: 'P' }),
      ],
      corrections: [
        // Delete is listed first but must run LAST within the group.
        { itemType: 'entity', operation: 'delete', source: 'doc.md', label: 'Artifact', remediationGroupId: 'g1', confidence: 0.9, ...EVIDENCE },
        { itemType: 'relationship', operation: 'retarget', source: 'doc.md', label: 'e', remediationGroupId: 'g1', confidence: 0.9, ...EVIDENCE, relationshipKey: { sourceLabel: 'Artifact', type: 'PERMITS', targetLabel: 'Shop' }, endpoint: 'source', newLabel: 'RZ' },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0, 1] }, dryRun: false });
    expect(result.skippedGroups ?? []).toHaveLength(0);
    const file = await readFileShape();
    expect(file.entities.some(e => e.label === 'Artifact')).toBe(false);
    // The retargeted edge survived; the edge still pointing at Artifact was cascaded.
    expect(file.relationships.map(r => `${r.sourceLabel}->${r.targetLabel}`)).toEqual(['RZ->Shop']);
    expect(result.cascaded!.some(c => c.relationshipKey.includes('Cafe'))).toBe(true);
  });

  it('aborts a group when a mid-group member fails, leaving the file untouched', async () => {
    await seed({
      entities: [ent('Zone', 'RZ')],
      corrections: [
        { itemType: 'entity', operation: 'create', source: 'doc.md', label: 'P1', remediationGroupId: 'g1', confidence: 0.9, ...EVIDENCE, entity: ent('Provision', 'P1') },
        // Target does not resolve → fails → aborts the group.
        { itemType: 'relationship', operation: 'create', source: 'doc.md', label: 'e', remediationGroupId: 'g1', confidence: 0.9, ...EVIDENCE, relationship: rel('APPLIES_IN', 'P1', 'Nonexistent', {}) },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0, 1] }, dryRun: false });
    expect(result.skippedGroups).toHaveLength(1);
    const file = await readFileShape();
    expect(file.entities.some(e => e.label === 'P1')).toBe(false);
  });

  // ── Confidence gate & group expansion ───────────────────────────────

  it('skips a group whose weakest member is below the confidence floor', async () => {
    await seed({
      entities: [ent('Zone', 'RZ')],
      corrections: [
        { itemType: 'entity', operation: 'create', source: 'doc.md', label: 'A', remediationGroupId: 'g1', confidence: 0.95, ...EVIDENCE, entity: ent('Provision', 'A') },
        { itemType: 'entity', operation: 'create', source: 'doc.md', label: 'B', remediationGroupId: 'g1', confidence: 0.7, ...EVIDENCE, entity: ent('Provision', 'B') },
      ],
    });
    const result = await applier().apply({ selection: { approveAll: true, minConfidence: 0.8 }, dryRun: false });
    expect(result.outcome).toBe('no-matches');
  });

  it('auto-expands a partial approvedIndices selection to the whole group', async () => {
    await seed({
      entities: [ent('Zone', 'RZ')],
      corrections: [
        { itemType: 'entity', operation: 'create', source: 'doc.md', label: 'Clause X', remediationGroupId: 'g1', confidence: 0.9, ...EVIDENCE, entity: ent('Provision', 'Clause X') },
        { itemType: 'relationship', operation: 'create', source: 'doc.md', label: 'e', remediationGroupId: 'g1', confidence: 0.9, ...EVIDENCE, relationship: rel('APPLIES_IN', 'Clause X', 'RZ', {}) },
      ],
    });
    const plan = await applier().apply({ selection: { approvedIndices: [0] }, dryRun: true });
    expect(plan.plan).toHaveLength(2);
    expect(plan.expansions![0]!.addedIndices).toEqual([1]);

    const applied = await applier().apply({ selection: { approvedIndices: [0] }, dryRun: false });
    const file = await readFileShape();
    expect(file.relationships.some(r => r.sourceLabel === 'Clause X')).toBe(true);
    expect(applied.expansions![0]!.remediationGroupId).toBe('g1');
  });

  it('is idempotent on re-apply', async () => {
    const corrections: ProposedCorrection[] = [
      { itemType: 'entity', operation: 'create', source: 'doc.md', label: 'Clause X', remediationGroupId: 'g1', confidence: 0.9, ...EVIDENCE, entity: ent('Provision', 'Clause X') },
      { itemType: 'relationship', operation: 'create', source: 'doc.md', label: 'e', remediationGroupId: 'g1', confidence: 0.9, ...EVIDENCE, relationship: rel('APPLIES_IN', 'Clause X', 'RZ', {}) },
    ];
    await seed({ entities: [ent('Zone', 'RZ')], corrections });

    await applier().apply({ selection: { approvedIndices: [0, 1] }, dryRun: false });
    const afterFirst = await readFileShape();

    const second = await applier().apply({ selection: { approvedIndices: [0, 1] }, dryRun: false });
    const afterSecond = await readFileShape();

    expect(second.skippedGroups ?? []).toHaveLength(0);
    expect(afterSecond.entities).toHaveLength(afterFirst.entities.length);
    expect(afterSecond.relationships).toHaveLength(afterFirst.relationships.length);
  });

  it('marks applied corrections approved and prunes to five backup sets', async () => {
    await seed({
      entities: [ent('Zone', 'RZ', { p: 'a' })],
      corrections: [
        { itemType: 'entity', operation: 'update', source: 'doc.md', label: 'RZ', property: 'p', correctedValue: 'b', confidence: 0.9, ...EVIDENCE },
      ],
    });
    for (let i = 0; i < 7; i += 1) {
      await state.saveFullValidationCorrections([
        { itemType: 'entity', operation: 'update', source: 'doc.md', label: 'RZ', property: 'p', correctedValue: `v${i}`, confidence: 0.9, ...EVIDENCE },
      ]);
      await applier().apply({ selection: { approvedIndices: [0] }, dryRun: false });
    }
    const backups = await readdir(join(stateDir, 'extraction-notes-backups'));
    expect(backups.length).toBeLessThanOrEqual(5);

    const saved = await state.getFullValidationCorrections<ProposedCorrection[]>();
    expect(saved![0]!.approved).toBe(true);
  });

  // ── Standalone collision & no-op guards ─────────────────────────────

  it('fails a standalone cross-type create collision', async () => {
    await seed({
      entities: [ent('Provision', 'Clause 3.3.6')],
      corrections: [
        { itemType: 'entity', operation: 'create', source: 'doc.md', label: 'Clause 3.3.6', confidence: 0.9, ...EVIDENCE, entity: ent('Zone', 'Clause 3.3.6') },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0] }, dryRun: false });
    expect(result.failed).toHaveLength(1);
    expect(result.created ?? []).toHaveLength(0);
  });

  it('does not back up or rewrite a source whose only work is an aborted group', async () => {
    await seed({
      entities: [ent('Provision', 'Clause 3.3.6'), ent('Zone', 'RZ')],
      corrections: [
        { itemType: 'entity', operation: 'create', source: 'doc.md', label: 'New Prov', remediationGroupId: 'g1', confidence: 0.9, ...EVIDENCE, entity: ent('Provision', 'New Prov') },
        { itemType: 'entity', operation: 'create', source: 'doc.md', label: 'Clause 3.3.6', remediationGroupId: 'g1', confidence: 0.9, ...EVIDENCE, entity: ent('Zone', 'Clause 3.3.6') },
      ],
    });
    const before = await readFile(join(stateDir, SELECTED_EXTRACTION), 'utf-8');

    const result = await applier().apply({ selection: { approvedIndices: [0, 1] }, dryRun: false });
    expect(result.skippedGroups).toHaveLength(1);
    expect(result.backupLocation).toBeUndefined();

    // No backup set was written for a source that never mutated…
    let backupsExist = true;
    try {
      await readdir(join(stateDir, 'extraction-notes-backups'));
    } catch {
      backupsExist = false;
    }
    expect(backupsExist).toBe(false);

    // …and the file is byte-for-byte unchanged (no whitespace renormalisation).
    const after = await readFile(join(stateDir, SELECTED_EXTRACTION), 'utf-8');
    expect(after).toBe(before);
  });

  // ── Apply-side conformance: full severity matrix ────────────────────

  it('fails an unknown-property create under both managed and open', async () => {
    const corrections: ProposedCorrection[] = [
      { itemType: 'entity', operation: 'create', source: 'doc.md', label: 'P', confidence: 0.9, ...EVIDENCE, entity: ent('Provision', 'P', { notADeclaredProp: 'x' }) },
    ];
    await seed({ corrections });
    const managed = await applier('managed').apply({ selection: { approvedIndices: [0] }, dryRun: false });
    expect(managed.failed).toHaveLength(1);
    // Core's message + suggestion are preserved verbatim.
    expect(managed.failed![0]!.error).toContain('Unknown property');
    expect(managed.failed![0]!.error).toContain('Known properties');

    await state.saveFullValidationCorrections(corrections);
    const open = await applier('open').apply({ selection: { approvedIndices: [0] }, dryRun: false });
    expect(open.failed).toHaveLength(1);
  });

  it('fails a property-type-mismatch create under open', async () => {
    await seed({
      corrections: [
        { itemType: 'entity', operation: 'create', source: 'doc.md', label: 'P', confidence: 0.9, ...EVIDENCE, entity: ent('Provision', 'P', { weight: 'heavy' }) },
      ],
    });
    const result = await applier('open').apply({ selection: { approvedIndices: [0] }, dryRun: false });
    expect(result.failed).toHaveLength(1);
    expect(result.created ?? []).toHaveLength(0);
  });

  it('admits an unknown type under open, surfacing the warning in both the dry-run plan and the apply result', async () => {
    const corrections: ProposedCorrection[] = [
      { itemType: 'entity', operation: 'create', source: 'doc.md', label: 'G', confidence: 0.9, ...EVIDENCE, entity: ent('Ghost', 'G') },
    ];
    await seed({ corrections });

    const plan = await applier('open').apply({ selection: { approvedIndices: [0] }, dryRun: true });
    expect(plan.plan).toHaveLength(1);
    expect(plan.warnings![0]!.warning).toBe('unknown-type-admitted');
    expect(plan.warnings![0]!.detail).toContain('Ghost');

    const applied = await applier('open').apply({ selection: { approvedIndices: [0] }, dryRun: false });
    expect(applied.created).toHaveLength(1);
    expect(applied.warnings![0]!.warning).toBe('unknown-type-admitted');
  });

  it('accepts arbitrary properties on a create of a type with zero declared properties', async () => {
    // LandUse declares no properties — core treats such a type as open to anything.
    await seed({
      corrections: [
        { itemType: 'entity', operation: 'create', source: 'doc.md', label: 'Shop', confidence: 0.9, ...EVIDENCE, entity: ent('LandUse', 'Shop', { anything: 'goes', count: 3 }) },
      ],
    });
    const result = await applier('managed').apply({ selection: { approvedIndices: [0] }, dryRun: false });
    expect(result.failed ?? []).toHaveLength(0);
    expect(result.created).toHaveLength(1);
    const file = await readFileShape();
    expect(file.entities[0]!.properties).toEqual({ anything: 'goes', count: 3 });
  });

  it('retargets past a pre-existing non-conforming property, letting a sibling update then fix it', async () => {
    await seed({
      entities: [ent('Zone', 'RZ'), ent('LandUse', 'Shop'), ent('LandUse', 'Shop2')],
      relationships: [rel('PERMITS', 'RZ', 'Shop', { permissibility: 'BAD' })],
      corrections: [
        // Retarget runs first (precedence) and must NOT re-check the bad property.
        { itemType: 'relationship', operation: 'retarget', source: 'doc.md', label: 'e', remediationGroupId: 'g1', confidence: 0.9, ...EVIDENCE, relationshipKey: { sourceLabel: 'RZ', type: 'PERMITS', targetLabel: 'Shop' }, endpoint: 'target', newLabel: 'Shop2' },
        // Update lands after, keyed on the post-retarget identity.
        { itemType: 'relationship', operation: 'update', source: 'doc.md', label: 'e', property: 'permissibility', correctedValue: 'P', remediationGroupId: 'g1', confidence: 0.9, ...EVIDENCE, relationshipKey: { sourceLabel: 'RZ', type: 'PERMITS', targetLabel: 'Shop2' } },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0, 1] }, dryRun: false });
    expect(result.skippedGroups ?? []).toHaveLength(0);
    const file = await readFileShape();
    expect(file.relationships).toHaveLength(1);
    expect(file.relationships[0]).toMatchObject({ sourceLabel: 'RZ', targetLabel: 'Shop2', properties: { permissibility: 'P' } });
  });

  it('retargets an unknown-type edge, admitting it with a warning', async () => {
    await seed({
      entities: [ent('Provision', 'A'), ent('Provision', 'B'), ent('Zone', 'RZ')],
      relationships: [rel('BOGUS_REL', 'A', 'RZ', {})],
      corrections: [
        { itemType: 'relationship', operation: 'retarget', source: 'doc.md', label: 'e', confidence: 0.9, ...EVIDENCE, relationshipKey: { sourceLabel: 'A', type: 'BOGUS_REL', targetLabel: 'RZ' }, endpoint: 'source', newLabel: 'B' },
      ],
    });
    const result = await applier().apply({ selection: { approvedIndices: [0] }, dryRun: false });
    expect(result.retargeted).toHaveLength(1);
    expect(result.warnings![0]!.warning).toBe('unretargetable-constraints-unknown-type');
    const file = await readFileShape();
    expect(file.relationships[0]!.sourceLabel).toBe('B');
  });
});
