import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PROCESS_STATE_FILE = 'process-state.md';

/** Phases of the human-level indexing process (distinct from pipeline phase) */
export type ProcessPhase =
  | 'initialized'
  | 'strategy-tuning'
  | 'sample-extraction'
  | 'validation-review'
  | 'full-extraction'
  | 'consolidation-review'
  | 'import'
  | 'complete';

/** A single iteration entry in the process state log */
export interface ProcessIteration {
  date: string;
  goal: string;
  documents?: string;
  result?: string;
  actions?: string[];
}

/**
 * Reads and writes the process-state.md file in a process directory.
 * This tracks the human-level iteration state — not the pipeline state,
 * but the meta-state of strategy tuning, sample runs, and reviews.
 */
export class ProcessStateWriter {
  private readonly filePath: string;

  constructor(processDir: string) {
    this.filePath = join(processDir, PROCESS_STATE_FILE);
  }

  /**
   * Initialize a new process-state.md with the given process name and starter kit.
   */
  async initialize(processName: string, starterKit: string, repositoryId: string): Promise<void> {
    const content = `# ${processName} — Indexing Process

## Current Phase: Initialized

**Starter Kit:** ${starterKit}
**Repository ID:** ${repositoryId}
**Created:** ${new Date().toISOString().split('T')[0]}

## Iteration Log

*No iterations yet. Run \`memory_indexing_analyze\` to preview work, then \`memory_indexing_extract\` with \`maxItems: 1\` to test on a single document.*
`;
    await writeFile(this.filePath, content, 'utf-8');
  }

  /**
   * Update the current phase heading in process-state.md.
   */
  async updatePhase(phase: ProcessPhase): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf-8');
    } catch {
      return; // File doesn't exist yet
    }

    const phaseLabel = formatPhaseLabel(phase);
    content = content.replace(
      /^## Current Phase: .+$/m,
      `## Current Phase: ${phaseLabel}`,
    );

    await writeFile(this.filePath, content, 'utf-8');
  }

  /**
   * Append a new iteration entry to the log.
   */
  async appendIteration(iteration: ProcessIteration): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf-8');
    } catch {
      return;
    }

    // Remove the placeholder text if present
    content = content.replace(
      /\n\*No iterations yet\..+\*\n?/,
      '\n',
    );

    // Count existing iterations to number the new one
    const iterationMatches = content.match(/### Iteration \d+/g);
    const nextNumber = (iterationMatches?.length ?? 0) + 1;

    let entry = `\n### Iteration ${nextNumber} — ${iteration.date}\n`;
    entry += `- **Goal:** ${iteration.goal}\n`;
    if (iteration.documents) {
      entry += `- **Documents:** ${iteration.documents}\n`;
    }
    if (iteration.result) {
      entry += `- **Result:** ${iteration.result}\n`;
    }
    if (iteration.actions && iteration.actions.length > 0) {
      for (const action of iteration.actions) {
        entry += `- **Action:** ${action}\n`;
      }
    }

    content = content.trimEnd() + '\n' + entry;

    await writeFile(this.filePath, content, 'utf-8');
  }

  /**
   * Read the current process-state.md content.
   */
  async read(): Promise<string | null> {
    try {
      return await readFile(this.filePath, 'utf-8');
    } catch {
      return null;
    }
  }
}

function formatPhaseLabel(phase: ProcessPhase): string {
  switch (phase) {
    case 'initialized': return 'Initialized';
    case 'strategy-tuning': return 'Strategy Tuning';
    case 'sample-extraction': return 'Sample Extraction';
    case 'validation-review': return 'Validation Review';
    case 'full-extraction': return 'Full Extraction';
    case 'consolidation-review': return 'Consolidation Review';
    case 'import': return 'Import';
    case 'complete': return 'Complete';
  }
}
