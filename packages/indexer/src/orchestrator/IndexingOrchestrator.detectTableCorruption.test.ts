import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IndexingOrchestrator } from './IndexingOrchestrator.js';
import { StateManager } from './StateManager.js';
import type { OrchestratorConfig } from '../types/config.js';
import { DEFAULT_QUALITY_THRESHOLDS } from '../types/config.js';
import type { IndexSource, IndexSourceList } from '../types/source-list.js';

/** One wide structural table that fragments into narrow Markdown sub-tables. */
const CORRUPT_GRID: string[][] = [
  ['Zone', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12', 'C13'],
  ['LPS12', 'P', 'D', 'A', 'X', 'P', 'D', 'Refer to Clause 3.3.6', 'A', 'X', 'P', 'D', 'A', 'X'],
  ['R2', 'D', 'P', 'X', 'A', 'D', 'Refer to', 'Clause 3.3.6', 'P', 'A', 'D', 'X', 'P', 'A'],
  ['R3', 'A', 'X', 'P', 'D', 'A', 'X', 'P', 'D', 'A', 'X', 'P', 'D', 'A'],
  ['R4', 'X', 'A', 'D', 'P', 'X', 'A', 'D', 'P', 'X', 'A', 'D', 'P', 'X'],
  ['R5', 'P', 'D', 'A', 'X', 'P', 'D', 'A', 'X', 'P', 'D', 'A', 'X', 'P'],
];

const CORRUPT_MARKDOWN = [
  '| Zone | C1 | C2 | C3 | C4 |',
  '| --- | --- | --- | --- | --- |',
  '| LPS12 | P | D | A | X |',
  '',
  '| C5 | C6 | C7 | C8 | C9 |',
  '| --- | --- | --- | --- | --- |',
  '| P | D | Refer to Clause 3.3.6 | A | X |',
  '',
  '| C10 | C11 | C12 | C13 |',
  '| --- | --- | --- | --- |',
  '| P | D | A | X |',
].join('\n');

const CLEAN_MARKDOWN = [
  '| Zone | Code | Use |',
  '| --- | --- | --- |',
  '| R1 | P | House |',
  '| R2 | D | Shop |',
].join('\n');

const CLEAN_GRID: string[][] = [
  ['Zone', 'Code', 'Use'],
  ['R1', 'P', 'House'],
  ['R2', 'D', 'Shop'],
];

function sidecarJson(grid: string[][], numCols: number): string {
  return JSON.stringify({
    filename: 'fixture.pdf',
    json_content: {
      tables: [
        {
          num_rows: grid.length,
          num_cols: numCols,
          data: {
            num_rows: grid.length,
            num_cols: numCols,
            grid: grid.map(row => row.map(text => ({ text }))),
          },
        },
      ],
    },
  });
}

function baseConfig(stateDir: string): OrchestratorConfig {
  return {
    stateDir,
    vocabularyPath: join(stateDir, 'vocabulary.md'),
    repositoryId: 'test-repo',
    extraction: { endpoint: 'http://localhost:0/v1', model: 'test', concurrency: 1 },
    consolidation: { endpoint: 'http://localhost:0/v1', model: 'test' },
    import: { storage: { type: 'memory' } },
    qualityThresholds: DEFAULT_QUALITY_THRESHOLDS,
  };
}

describe('IndexingOrchestrator.detectTableCorruption', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'detect-table-'));
    const state = new StateManager(stateDir);
    await state.initialize();

    // Write the converted artifacts each source points at.
    const write = async (slug: string, markdown: string, sidecar: string) => {
      const md = join(stateDir, `${slug}.md`);
      const js = join(stateDir, `${slug}.docling.json`);
      await writeFile(md, markdown, 'utf-8');
      await writeFile(js, sidecar, 'utf-8');
      return { md, js };
    };

    const corrupt = await write('corrupt-default', CORRUPT_MARKDOWN, sidecarJson(CORRUPT_GRID, 14));
    const flagged = await write('corrupt-flagged', CORRUPT_MARKDOWN, sidecarJson(CORRUPT_GRID, 14));
    const clean = await write('clean-doc', CLEAN_MARKDOWN, sidecarJson(CLEAN_GRID, 3));
    const excluded = await write('excluded-doc', CORRUPT_MARKDOWN, sidecarJson(CORRUPT_GRID, 14));

    const sources: IndexSource[] = [
      // Corrupt under docling defaults — earns an executable re-convert.
      {
        path: '/docs/corrupt-default.pdf',
        type: 'general',
        status: 'pending',
        derivedTextPath: corrupt.md,
        derivedDoclingJsonPath: corrupt.js,
      },
      // Corrupt but already converted with the flag — no re-convert advice.
      {
        path: '/docs/corrupt-flagged.pdf',
        type: 'general',
        status: 'pending',
        derivedTextPath: flagged.md,
        derivedDoclingJsonPath: flagged.js,
        convertOptionsUsed: { tableCellMatching: false },
      },
      // Clean — no recommendation.
      {
        path: '/docs/clean-doc.pdf',
        type: 'general',
        status: 'pending',
        derivedTextPath: clean.md,
        derivedDoclingJsonPath: clean.js,
      },
      // Corrupt content but excluded — must be skipped.
      {
        path: '/docs/excluded-doc.pdf',
        type: 'general',
        status: 'excluded',
        derivedTextPath: excluded.md,
        derivedDoclingJsonPath: excluded.js,
      },
      // No structural sidecar (plain-text source) — must be skipped.
      {
        path: '/docs/plain.md',
        type: 'general',
        status: 'pending',
      },
    ];

    const sourceList: IndexSourceList = { version: '1.0.0', repositoryId: 'test-repo', sources };
    await state.saveSourceList(sourceList);
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('recommends only the corrupt sources, gating remediation on recorded options', async () => {
    const orchestrator = new IndexingOrchestrator(baseConfig(stateDir));
    const recommendations = await orchestrator.detectTableCorruption();

    const bySource = new Map(recommendations.map(r => [r.source, r]));
    expect([...bySource.keys()].sort()).toEqual(['corrupt-default.pdf', 'corrupt-flagged.pdf']);

    // Default-options source earns the executable re-convert.
    const def = bySource.get('corrupt-default.pdf');
    expect(def?.remediation).toBeDefined();
    expect(def?.remediation?.args.sourceConvertOptions.tableCellMatching).toBe(false);

    // Already-flagged source is surfaced but carries no re-convert (never loops).
    const flagged = bySource.get('corrupt-flagged.pdf');
    expect(flagged?.remediation).toBeUndefined();

    // Clean, excluded, and no-sidecar sources produce nothing.
    expect(bySource.has('clean-doc.pdf')).toBe(false);
    expect(bySource.has('excluded-doc.pdf')).toBe(false);
    expect(bySource.has('plain.md')).toBe(false);
  });

  it('honours the source filter', async () => {
    const orchestrator = new IndexingOrchestrator(baseConfig(stateDir));
    const recommendations = await orchestrator.detectTableCorruption(['corrupt-default']);
    expect(recommendations.map(r => r.source)).toEqual(['corrupt-default.pdf']);
  });
});
