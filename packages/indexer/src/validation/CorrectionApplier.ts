/**
 * Deterministic applier for full-validation corrections.
 *
 * Executes the correction operations a validation worker proposes against the
 * on-disk extraction-notes files. Zero LLM involvement: every decision here is
 * mechanical and reproducible. The applier owns the whole apply contract —
 * selection, grouping, ordering, endpoint resolution, collision policy,
 * vocabulary conformance enforcement, per-file backups, atomic writes, and the
 * structured report — so the MCP tool above it is a thin param-parse-and-shape
 * layer.
 *
 * Corrections carrying a shared `remediationGroupId` form a remodel that applies
 * as one atomic unit: every member is prechecked against the group's own
 * progressive state, and the group commits only if all members pass. A single
 * failing member skips the whole group, leaving the file untouched. Standalone
 * corrections keep per-item semantics — a not-found match is a skip, not a
 * failure, so a partial batch never throws.
 */

import { join, dirname } from 'node:path';
import { readFile, writeFile, mkdir, rename, readdir, rm, copyFile } from 'node:fs/promises';
import { validateEntity, validateRelationship } from '@utaba/deep-memory';
import type {
  MemoryVocabulary,
  GovernanceMode,
  CreateEntityInput,
  CreateRelationshipInput,
  ValidationError,
} from '@utaba/deep-memory';
import { InvalidInputError } from '@utaba/deep-memory';
import type { StateManager } from '../orchestrator/StateManager.js';
import type { ExtractedEntity, ExtractedRelationship } from '../types/extraction.js';
import type {
  ProposedCorrection,
  PropertyCorrection,
  DeleteCorrection,
  CreateEntityCorrection,
  CreateRelationshipCorrection,
  RetargetRelationshipCorrection,
  CorrectionOperation,
  RelationshipKey,
} from './full-validation-types.js';

// ── Extraction file shape ──────────────────────────────────────────────

/**
 * An entity/relationship as it lives in an extraction-notes file. Typed as the
 * canonical extraction shape intersected with an open index signature so any
 * extra fields a file carries survive the load → mutate → write round-trip
 * untouched.
 */
type ExtractionEntityRecord = ExtractedEntity & Record<string, unknown>;
type ExtractionRelationshipRecord = ExtractedRelationship & Record<string, unknown>;

interface ExtractionFile {
  entities: ExtractionEntityRecord[];
  relationships: ExtractionRelationshipRecord[];
  [k: string]: unknown;
}

// ── Selection / options ────────────────────────────────────────────────

/** How the caller selects which corrections to apply. */
export interface CorrectionSelection {
  /** Apply every not-yet-approved correction at or above `minConfidence`. */
  approveAll?: boolean;
  /** Confidence floor for `approveAll` (default 0.8). Also gates group eligibility. */
  minConfidence?: number;
  /** Explicit correction indices to apply (bypasses the confidence floor). */
  approvedIndices?: number[];
}

export interface ApplyCorrectionsOptions {
  selection: CorrectionSelection;
  /** When true, no files are backed up or written — only a plan (with projected warnings) is returned. */
  dryRun: boolean;
}

// ── Report shapes ──────────────────────────────────────────────────────

/** What happened overall — drives how the caller renders its response. */
export type ApplyOutcome =
  | 'no-corrections'
  | 'no-selection'
  | 'no-matches'
  | 'dry-run'
  | 'applied';

/** A flattened, per-operation-narrowed view of a correction for listing / planning. */
export interface CorrectionSummaryItem {
  index: number;
  source: string;
  itemType: 'entity' | 'relationship';
  operation: CorrectionOperation;
  label: string;
  confidence: number;
  approved?: boolean;
  remediationGroupId?: string;
  /** Property ops */
  property?: string;
  originalValue?: unknown;
  correctedValue?: unknown;
  /** Entity create */
  entityType?: string;
  /** Create ops — number of properties on the created item */
  propertyCount?: number;
  /** Relationship create — "source → [type] → target" */
  relationship?: string;
  /** Retarget — "old ⇒ new" */
  retarget?: string;
}

export interface AppliedCorrectionRef {
  index: number;
  source: string;
  itemType: 'entity' | 'relationship';
  operation: CorrectionOperation;
  label: string;
  property?: string;
}

export interface CreatedEntityRef {
  index: number;
  source: string;
  entityType: string;
  label: string;
}

export interface RetargetedRef {
  index: number;
  source: string;
  /** "A →[T]→ B ⇒ A →[T]→ C" */
  relationship: string;
  deduplicated?: boolean;
}

/**
 * Why a correction was skipped.
 * - `already-exists` — a create found an equivalent item; the desired end-state holds (idempotent success).
 * - `already-absent` — a delete found nothing to remove; the desired end-state holds (idempotent success).
 * - `not-found` — a mutation's target is unexpectedly missing; retryable, and group-aborting inside a group.
 */
export type CorrectionSkipKind = 'already-exists' | 'already-absent' | 'not-found';

export interface SkippedCorrectionRef {
  index: number;
  source: string;
  label: string;
  kind: CorrectionSkipKind;
  reason: string;
}

export interface FailedCorrectionRef {
  index: number;
  source: string;
  label: string;
  error: string;
}

export interface CascadedRef {
  source: string;
  relationshipKey: string;
  reason: string;
}

export interface SkippedGroupRef {
  remediationGroupId: string;
  reason: string;
  memberIndices: number[];
}

export interface GroupExpansionRef {
  remediationGroupId: string;
  /** Indices the caller explicitly requested */
  requestedIndices: number[];
  /** Sibling indices pulled in so the group applies atomically */
  addedIndices: number[];
}

/** A correction that was admitted despite a conformance concern the governance mode tolerates. */
export type CorrectionWarningCode = 'unknown-type-admitted' | 'unretargetable-constraints-unknown-type';

export interface CorrectionWarningRef {
  index: number;
  source: string;
  label: string;
  warning: CorrectionWarningCode;
  /** Core's verbatim validation message (and suggestion) that triggered the warning. */
  detail: string;
}

export interface ApplyCorrectionsResult {
  outcome: ApplyOutcome;
  totalCorrections: number;
  /** `no-selection` only — counts keyed by "itemType:operation". */
  byOperation?: Record<string, number>;
  /** `no-selection` only — the full correction listing. */
  listing?: CorrectionSummaryItem[];
  /** `dry-run` only — the corrections that would be applied. */
  plan?: CorrectionSummaryItem[];
  /** Group auto-expansions triggered by partial `approvedIndices` selection. */
  expansions?: GroupExpansionRef[];
  applied?: AppliedCorrectionRef[];
  created?: CreatedEntityRef[];
  retargeted?: RetargetedRef[];
  skipped?: SkippedCorrectionRef[];
  failed?: FailedCorrectionRef[];
  cascaded?: CascadedRef[];
  skippedGroups?: SkippedGroupRef[];
  /** Warn-and-proceed conformance admissions — present on both dry-run and applied results. */
  warnings?: CorrectionWarningRef[];
  backupLocation?: string;
}

// ── Internal apply outcomes ────────────────────────────────────────────

interface WarningPayload {
  code: CorrectionWarningCode;
  detail: string;
}

type ApplyOneOutcome =
  | { kind: 'applied'; ref: AppliedCorrectionRef; cascaded?: CascadedRef[]; warning?: WarningPayload }
  | { kind: 'created'; ref: CreatedEntityRef; warning?: WarningPayload }
  | { kind: 'retargeted'; ref: RetargetedRef; warning?: WarningPayload }
  | { kind: 'skipped'; category: CorrectionSkipKind; reason: string }
  | { kind: 'failed'; reason: string };

/** Outcome of an apply-side conformance check. */
type ConformanceCheck =
  | { kind: 'ok' }
  | { kind: 'ok-warn'; code: CorrectionWarningCode; detail: string }
  | { kind: 'fail'; reason: string };

/** Mutable accumulators threaded through one apply pass (global) or one source (local). */
interface Accumulators {
  applied: AppliedCorrectionRef[];
  created: CreatedEntityRef[];
  retargeted: RetargetedRef[];
  skipped: SkippedCorrectionRef[];
  failed: FailedCorrectionRef[];
  cascaded: CascadedRef[];
  skippedGroups: SkippedGroupRef[];
  warnings: CorrectionWarningRef[];
  /** Indices whose corrections reached the desired end-state (applied / created / retargeted / idempotent skip). */
  succeeded: Set<number>;
}

interface SelectedItem {
  index: number;
  correction: ProposedCorrection;
}

/**
 * Precedence order within a group. Creates run before the edges that reference
 * them; retargets run before deletes so an edge moved off an artifact entity
 * escapes that entity's delete-cascade while genuinely stranded edges are still
 * swept, and before property fixes so a sibling `update` lands after the edge is
 * repositioned.
 */
const OPERATION_PRECEDENCE: Record<CorrectionOperation, number> = {
  create: 0,
  retarget: 1,
  update: 2,
  'remove-property': 2,
  delete: 3,
};

export class CorrectionApplier {
  private readonly state: StateManager;
  private readonly vocabulary: MemoryVocabulary;
  private readonly mode: GovernanceMode;

  public constructor(state: StateManager, vocabulary: MemoryVocabulary, mode: GovernanceMode) {
    this.state = state;
    this.vocabulary = vocabulary;
    this.mode = mode;
  }

  /** Load, select, and (unless dry-run) apply corrections, returning a structured report. */
  public async apply(options: ApplyCorrectionsOptions): Promise<ApplyCorrectionsResult> {
    const all = await this.state.getFullValidationCorrections<ProposedCorrection[]>();
    if (!all || all.length === 0) {
      return { outcome: 'no-corrections', totalCorrections: 0 };
    }

    const groupMembers = this.indexGroups(all);
    const selection = this.select(all, groupMembers, options.selection);

    if (selection.kind === 'listing') {
      return {
        outcome: 'no-selection',
        totalCorrections: all.length,
        byOperation: summarizeCorrectionsByOperation(all),
        listing: all.map((c, i) => toSummaryItem(c, i)),
      };
    }

    if (selection.items.length === 0) {
      return { outcome: 'no-matches', totalCorrections: all.length };
    }

    return this.run(all, selection.items, selection.expansions, !options.dryRun);
  }

  // ── Selection ──────────────────────────────────────────────────────

  private indexGroups(all: ProposedCorrection[]): Map<string, number[]> {
    const groups = new Map<string, number[]>();
    all.forEach((c, i) => {
      if (!c.remediationGroupId) return;
      const list = groups.get(c.remediationGroupId) ?? [];
      list.push(i);
      groups.set(c.remediationGroupId, list);
    });
    return groups;
  }

  private select(
    all: ProposedCorrection[],
    groupMembers: Map<string, number[]>,
    selection: CorrectionSelection,
  ):
    | { kind: 'listing' }
    | { kind: 'selected'; items: SelectedItem[]; expansions: GroupExpansionRef[] } {
    const floor = selection.minConfidence ?? 0.8;
    const selected = new Set<number>();
    const expansions: GroupExpansionRef[] = [];

    if (selection.approveAll) {
      all.forEach((c, i) => {
        if (c.approved || c.remediationGroupId) return;
        if (c.confidence >= floor) selected.add(i);
      });
      // A group rides its weakest member: eligible only when the minimum member
      // confidence clears the floor, and then it commits or skips whole.
      for (const members of groupMembers.values()) {
        const minConfidence = Math.min(...members.map(i => all[i]!.confidence));
        if (minConfidence < floor) continue;
        for (const i of members) {
          if (!all[i]!.approved) selected.add(i);
        }
      }
    } else if (selection.approvedIndices) {
      const requested = selection.approvedIndices.filter(i => i >= 0 && i < all.length);
      const requestedSet = new Set(requested);
      for (const i of requested) selected.add(i);
      // Approving any member of a group auto-expands to the whole group so the
      // remodel stays atomic; the expansion is reported so it is visible first
      // in the dry-run plan.
      for (const i of requested) {
        const gid = all[i]!.remediationGroupId;
        if (!gid) continue;
        for (const member of groupMembers.get(gid) ?? []) selected.add(member);
      }
      for (const [gid, members] of groupMembers) {
        const requestedMembers = members.filter(m => requestedSet.has(m));
        if (requestedMembers.length === 0) continue;
        const addedMembers = members.filter(m => !requestedSet.has(m));
        if (addedMembers.length > 0) {
          expansions.push({
            remediationGroupId: gid,
            requestedIndices: requestedMembers,
            addedIndices: addedMembers,
          });
        }
      }
    } else {
      return { kind: 'listing' };
    }

    const items: SelectedItem[] = [...selected]
      .sort((a, b) => a - b)
      .map(index => ({ index, correction: all[index]! }));
    return { kind: 'selected', items, expansions };
  }

  // ── Apply / dry-run pass ────────────────────────────────────────────

  private async run(
    all: ProposedCorrection[],
    items: SelectedItem[],
    expansions: GroupExpansionRef[],
    persist: boolean,
  ): Promise<ApplyCorrectionsResult> {
    this.assertGroupsSingleSource(items);

    const report = newAccumulators();
    const approved = new Set<number>();

    const bySource = new Map<string, SelectedItem[]>();
    for (const item of items) {
      const list = bySource.get(item.correction.source) ?? [];
      list.push(item);
      bySource.set(item.correction.source, list);
    }

    const stateDir = this.state.getStateDirPath();
    const sourceList = await this.state.getSourceList();
    const sourceEntries = sourceList?.sources ?? [];

    // One backup set per apply call, named by an ISO timestamp (`:`/`.` → `-`)
    // so lexicographic order matches chronological order for pruning.
    const backupRoot = persist
      ? join(stateDir, 'extraction-notes-backups', new Date().toISOString().replace(/[:.]/g, '-'))
      : undefined;

    let anyWrite = false;
    for (const [source, sourceItems] of bySource) {
      const wrote = await this.applyToSource(source, sourceItems, stateDir, sourceEntries, backupRoot, persist, report, approved);
      anyWrite = anyWrite || wrote;
    }

    if (persist) {
      for (const index of approved) {
        const correction = all[index];
        if (correction) correction.approved = true;
      }
      await this.state.saveFullValidationCorrections(all);
      if (anyWrite) await pruneBackupSets(join(stateDir, 'extraction-notes-backups'), 5);
    }

    if (!persist) {
      return {
        outcome: 'dry-run',
        totalCorrections: all.length,
        plan: items.map(({ index, correction }) => toSummaryItem(correction, index)),
        warnings: report.warnings.length > 0 ? report.warnings : undefined,
        expansions: expansions.length > 0 ? expansions : undefined,
      };
    }

    return {
      outcome: 'applied',
      totalCorrections: all.length,
      applied: report.applied,
      created: report.created.length > 0 ? report.created : undefined,
      retargeted: report.retargeted.length > 0 ? report.retargeted : undefined,
      skipped: report.skipped.length > 0 ? report.skipped : undefined,
      failed: report.failed.length > 0 ? report.failed : undefined,
      cascaded: report.cascaded.length > 0 ? report.cascaded : undefined,
      skippedGroups: report.skippedGroups.length > 0 ? report.skippedGroups : undefined,
      warnings: report.warnings.length > 0 ? report.warnings : undefined,
      expansions: expansions.length > 0 ? expansions : undefined,
      backupLocation: anyWrite ? backupRoot : undefined,
    };
  }

  /**
   * A remediation group is a single-source atomic unit. A group whose members
   * span multiple source files is structurally corrupt (the proposer enforces
   * one source per group), so treat it as malformed input rather than trying to
   * apply half of it.
   */
  private assertGroupsSingleSource(items: SelectedItem[]): void {
    const sourcesByGroup = new Map<string, Set<string>>();
    for (const { correction } of items) {
      const gid = correction.remediationGroupId;
      if (!gid) continue;
      const sources = sourcesByGroup.get(gid) ?? new Set<string>();
      sources.add(correction.source);
      sourcesByGroup.set(gid, sources);
    }
    for (const [gid, sources] of sourcesByGroup) {
      if (sources.size > 1) {
        throw new InvalidInputError(
          'remediationGroupId',
          `Remediation group "${gid}" spans multiple source files (${[...sources].join(', ')}); a group must belong to a single source.`,
        );
      }
    }
  }

  /**
   * Apply the corrections for one source file. Returns whether the file was
   * written. Corrections are accumulated locally first, then merged into the
   * shared report only after the source's outcome is settled: a source is
   * written (and its successful corrections marked approved) only when it is
   * dirty and both backup and atomic write succeed — a clean source (e.g. a lone
   * aborted group) is never backed up or rewritten, and a write failure marks the
   * whole source's items failed rather than silently approving unwritten changes.
   */
  private async applyToSource(
    source: string,
    sourceItems: SelectedItem[],
    stateDir: string,
    sourceEntries: Array<{ path: string; selectedExtraction?: string }>,
    backupRoot: string | undefined,
    persist: boolean,
    report: Accumulators,
    approved: Set<number>,
  ): Promise<boolean> {
    const sourceEntry = sourceEntries.find(s => s.path.endsWith(source) || s.path.includes(source));
    const selectedPath = sourceEntry?.selectedExtraction;
    if (!selectedPath) {
      this.failAll(sourceItems, source, 'no selectedExtraction set for this source', report);
      return false;
    }
    const extractionPath = join(stateDir, selectedPath);

    let extraction: ExtractionFile;
    try {
      const content = await readFile(extractionPath, 'utf-8');
      extraction = JSON.parse(content) as ExtractionFile;
    } catch (error) {
      this.failAll(sourceItems, source, `failed to read extraction: ${messageOf(error)}`, report);
      return false;
    }

    // Process selected corrections in list order into a local accumulator. A
    // group is handled as one atomic unit at the position of its first member.
    const local = newAccumulators();
    const processedGroups = new Set<string>();
    for (const item of sourceItems) {
      const gid = item.correction.remediationGroupId;
      if (gid) {
        if (processedGroups.has(gid)) continue;
        processedGroups.add(gid);
        const groupItems = sourceItems.filter(x => x.correction.remediationGroupId === gid);
        this.applyGroup(extraction, gid, groupItems, source, local);
      } else {
        const outcome = this.applyOne(extraction, item.correction, item.index, source);
        this.record(outcome, item, local);
      }
    }

    const dirty = local.succeeded.size > 0 || local.cascaded.length > 0;

    if (persist && dirty && backupRoot) {
      // Back up the original before any mutation, preserving the selectedPath
      // structure under the timestamped backup folder.
      const backupTarget = join(backupRoot, selectedPath);
      try {
        await mkdir(dirname(backupTarget), { recursive: true });
        await copyFile(extractionPath, backupTarget);
      } catch (error) {
        this.failAll(sourceItems, source, `backup failed: ${messageOf(error)}`, report);
        return false;
      }

      // Atomic write: write a sibling `.tmp` then rename over the original, so a
      // crash mid-write leaves the original intact.
      try {
        const tmpPath = `${extractionPath}.tmp`;
        await writeFile(tmpPath, JSON.stringify(extraction, null, 2) + '\n', 'utf-8');
        await rename(tmpPath, extractionPath);
      } catch (error) {
        this.failAll(sourceItems, source, `write failed: ${messageOf(error)}`, report);
        return false;
      }

      mergeInto(report, local);
      for (const index of local.succeeded) approved.add(index);
      return true;
    }

    // Clean source (nothing mutated) or dry run: surface the outcomes without
    // writing and without marking anything approved.
    mergeInto(report, local);
    return false;
  }

  private applyGroup(
    extraction: ExtractionFile,
    gid: string,
    groupItems: SelectedItem[],
    source: string,
    acc: Accumulators,
  ): void {
    const ordered = [...groupItems].sort((a, b) => {
      const pa = OPERATION_PRECEDENCE[a.correction.operation];
      const pb = OPERATION_PRECEDENCE[b.correction.operation];
      return pa !== pb ? pa - pb : a.index - b.index;
    });

    // Precheck against a working copy of the mutable arrays so the group's own
    // creates are visible to later members, without touching the real file until
    // every member reaches its desired end-state.
    const working: ExtractionFile = { ...extraction };
    working.entities = structuredClone(extraction.entities);
    working.relationships = structuredClone(extraction.relationships);

    const memberOutcomes: Array<{ item: SelectedItem; outcome: ApplyOneOutcome }> = [];
    let abortReason: string | undefined;
    for (const item of ordered) {
      const outcome = this.applyOne(working, item.correction, item.index, source);
      memberOutcomes.push({ item, outcome });
      // A hard failure aborts; so does a not-found target (its sibling members
      // would otherwise apply against a state that no longer matches the remodel).
      // Idempotent skips (already-exists / already-absent) keep the group intact.
      if (outcome.kind === 'failed') {
        abortReason = outcome.reason;
        break;
      }
      if (outcome.kind === 'skipped' && outcome.category === 'not-found') {
        abortReason = outcome.reason;
        break;
      }
    }

    if (abortReason !== undefined) {
      acc.skippedGroups.push({
        remediationGroupId: gid,
        reason: `group-aborted: ${abortReason}`,
        memberIndices: groupItems.map(g => g.index).sort((a, b) => a - b),
      });
      return;
    }

    // Adopt the working arrays into the real file object (preserving any extra
    // top-level fields) and record every member's outcome.
    extraction.entities = working.entities;
    extraction.relationships = working.relationships;
    for (const { item, outcome } of memberOutcomes) this.record(outcome, item, acc);
  }

  // ── Per-correction application ──────────────────────────────────────

  private applyOne(
    file: ExtractionFile,
    correction: ProposedCorrection,
    index: number,
    source: string,
  ): ApplyOneOutcome {
    switch (correction.operation) {
      case 'update':
      case 'remove-property':
        return this.applyProperty(file, correction, index, source);
      case 'delete':
        return this.applyDelete(file, correction, index, source);
      case 'create':
        return correction.itemType === 'entity'
          ? this.applyCreateEntity(file, correction, index, source)
          : this.applyCreateRelationship(file, correction, index, source);
      case 'retarget':
        return this.applyRetarget(file, correction, index, source);
    }
  }

  private applyProperty(
    file: ExtractionFile,
    c: PropertyCorrection,
    index: number,
    source: string,
  ): ApplyOneOutcome {
    // Guard malformed on-disk data: the type requires `property`, but a
    // hand-edited file could omit it — fail cleanly rather than writing an
    // "undefined"-keyed property.
    if (!c.property) {
      return { kind: 'failed', reason: `${c.itemType}:${c.operation} missing property field` };
    }

    if (c.itemType === 'entity') {
      const entity = file.entities.find(e => e.label === c.label);
      if (!entity) {
        return { kind: 'skipped', category: 'not-found', reason: 'entity not found (may have been deleted by a prior correction)' };
      }
      if (c.operation === 'update') {
        entity.properties[c.property] = c.correctedValue;
      } else {
        delete entity.properties[c.property];
      }
      return { kind: 'applied', ref: { index, source, itemType: 'entity', operation: c.operation, label: c.label, property: c.property } };
    }

    if (!c.relationshipKey) {
      return { kind: 'failed', reason: `relationship:${c.operation} missing relationshipKey` };
    }
    const rel = findRelationship(file, c.relationshipKey);
    if (!rel) {
      return { kind: 'skipped', category: 'not-found', reason: 'relationship not found (may have been cascaded or deleted)' };
    }
    if (c.operation === 'update') {
      rel.properties[c.property] = c.correctedValue;
    } else {
      delete rel.properties[c.property];
    }
    return { kind: 'applied', ref: { index, source, itemType: 'relationship', operation: c.operation, label: c.label, property: c.property } };
  }

  private applyDelete(
    file: ExtractionFile,
    c: DeleteCorrection,
    index: number,
    source: string,
  ): ApplyOneOutcome {
    if (c.itemType === 'entity') {
      const before = file.entities.length;
      file.entities = file.entities.filter(e => e.label !== c.label);
      if (file.entities.length === before) {
        return { kind: 'skipped', category: 'already-absent', reason: 'entity not found (already absent)' };
      }
      const dropped = file.relationships.filter(r => r.sourceLabel === c.label || r.targetLabel === c.label);
      file.relationships = file.relationships.filter(r => r.sourceLabel !== c.label && r.targetLabel !== c.label);
      const cascaded: CascadedRef[] = dropped.map(r => ({
        source,
        relationshipKey: `${r.sourceLabel} → [${r.type}] → ${r.targetLabel}`,
        reason: `entity deleted: ${c.label}`,
      }));
      return { kind: 'applied', ref: { index, source, itemType: 'entity', operation: 'delete', label: c.label }, cascaded };
    }

    if (!c.relationshipKey) {
      return { kind: 'failed', reason: 'relationship:delete missing relationshipKey' };
    }
    const rk = c.relationshipKey;
    const before = file.relationships.length;
    file.relationships = file.relationships.filter(r => !(r.sourceLabel === rk.sourceLabel && r.type === rk.type && r.targetLabel === rk.targetLabel));
    if (file.relationships.length === before) {
      return { kind: 'skipped', category: 'already-absent', reason: 'relationship not found (already absent)' };
    }
    return { kind: 'applied', ref: { index, source, itemType: 'relationship', operation: 'delete', label: c.label } };
  }

  private applyCreateEntity(
    file: ExtractionFile,
    c: CreateEntityCorrection,
    index: number,
    source: string,
  ): ApplyOneOutcome {
    const entity = c.entity;
    if (!entity.sourceRefs || entity.sourceRefs.length === 0) {
      return { kind: 'failed', reason: 'created entity has no sourceRefs — provenance cannot be synthesized' };
    }

    const existing = file.entities.find(e => e.label.toLowerCase() === entity.label.toLowerCase());
    if (existing) {
      if (existing.entityType.toLowerCase() === entity.entityType.toLowerCase()) {
        return { kind: 'skipped', category: 'already-exists', reason: `entity "${entity.label}" (${entity.entityType}) already present` };
      }
      return { kind: 'failed', reason: `create collision: label "${entity.label}" already exists as type "${existing.entityType}", cannot also create as "${entity.entityType}"` };
    }

    const check = this.checkEntityConformance(entity);
    if (check.kind === 'fail') return { kind: 'failed', reason: check.reason };

    const record: ExtractionEntityRecord = { ...entity, aliases: entity.aliases ?? [] };
    file.entities.push(record);
    return { kind: 'created', ref: { index, source, entityType: entity.entityType, label: entity.label }, warning: warningOf(check) };
  }

  private applyCreateRelationship(
    file: ExtractionFile,
    c: CreateRelationshipCorrection,
    index: number,
    source: string,
  ): ApplyOneOutcome {
    const rel = c.relationship;
    if (!rel.sourceRefs || rel.sourceRefs.length === 0) {
      return { kind: 'failed', reason: 'created relationship has no sourceRefs — provenance cannot be synthesized' };
    }

    const entities = buildEntityMap(file);
    const src = entities.get(rel.sourceLabel.toLowerCase());
    if (!src) {
      return { kind: 'failed', reason: `create relationship: source label "${rel.sourceLabel}" does not resolve to an entity in this file` };
    }
    const tgt = entities.get(rel.targetLabel.toLowerCase());
    if (!tgt) {
      return { kind: 'failed', reason: `create relationship: target label "${rel.targetLabel}" does not resolve to an entity in this file` };
    }

    const duplicate = file.relationships.find(r => r.sourceLabel === src.label && r.type === rel.type && r.targetLabel === tgt.label);
    if (duplicate) {
      return { kind: 'skipped', category: 'already-exists', reason: `relationship ${src.label} → [${rel.type}] → ${tgt.label} already present` };
    }

    const check = this.checkRelationshipConformance(rel.type, rel.properties, src.entityType, tgt.entityType);
    if (check.kind === 'fail') return { kind: 'failed', reason: check.reason };

    const record: ExtractionRelationshipRecord = { ...rel, sourceLabel: src.label, targetLabel: tgt.label };
    file.relationships.push(record);
    return {
      kind: 'applied',
      ref: { index, source, itemType: 'relationship', operation: 'create', label: `${src.label} → [${rel.type}] → ${tgt.label}` },
      warning: warningOf(check),
    };
  }

  private applyRetarget(
    file: ExtractionFile,
    c: RetargetRelationshipCorrection,
    index: number,
    source: string,
  ): ApplyOneOutcome {
    const rk = c.relationshipKey;
    const rel = findRelationship(file, rk);
    if (!rel) {
      return { kind: 'skipped', category: 'not-found', reason: 'relationship not found (may have been cascaded or deleted)' };
    }

    const entities = buildEntityMap(file);
    const resolved = entities.get(c.newLabel.toLowerCase());
    if (!resolved) {
      return { kind: 'failed', reason: `retarget: new ${c.endpoint} label "${c.newLabel}" does not resolve to an entity in this file` };
    }

    const newSourceLabel = c.endpoint === 'source' ? resolved.label : rel.sourceLabel;
    const newTargetLabel = c.endpoint === 'target' ? resolved.label : rel.targetLabel;

    const srcEntity = c.endpoint === 'source' ? resolved : entities.get(rel.sourceLabel.toLowerCase());
    const tgtEntity = c.endpoint === 'target' ? resolved : entities.get(rel.targetLabel.toLowerCase());
    if (!srcEntity) {
      return { kind: 'failed', reason: `retarget: source label "${rel.sourceLabel}" does not resolve to an entity in this file` };
    }
    if (!tgtEntity) {
      return { kind: 'failed', reason: `retarget: target label "${rel.targetLabel}" does not resolve to an entity in this file` };
    }

    // Retarget validates only what it writes: the endpoint constraint against
    // the moved endpoint's resolved type. Pre-existing property defects on the
    // rest of the edge are out of scope (same boundary as update/remove-property).
    const check = this.checkRetargetEndpoints(rel.type, srcEntity.entityType, tgtEntity.entityType);
    if (check.kind === 'fail') return { kind: 'failed', reason: check.reason };

    const oldDisplay = `${rel.sourceLabel} →[${rel.type}]→ ${rel.targetLabel}`;
    const newDisplay = `${newSourceLabel} →[${rel.type}]→ ${newTargetLabel}`;

    const duplicate = file.relationships.find(
      r => r !== rel && r.sourceLabel === newSourceLabel && r.type === rel.type && r.targetLabel === newTargetLabel,
    );
    if (duplicate) {
      // Retargeting would collide with an existing edge: drop the retargeted
      // edge and let the surviving edge keep its properties.
      file.relationships = file.relationships.filter(r => r !== rel);
      return { kind: 'retargeted', ref: { index, source, relationship: `${oldDisplay} ⇒ ${newDisplay}`, deduplicated: true }, warning: warningOf(check) };
    }

    rel.sourceLabel = newSourceLabel;
    rel.targetLabel = newTargetLabel;
    return { kind: 'retargeted', ref: { index, source, relationship: `${oldDisplay} ⇒ ${newDisplay}` }, warning: warningOf(check) };
  }

  // ── Apply-side conformance (core validators) ────────────────────────

  /**
   * Apply-side conformance mirrors the strictness of core's *live* create path:
   * `EntityManager.create` / relationship create throw on any validation error
   * with no governance branch, and import re-validates these same items against
   * the live vocabulary — so a create admitted here on lenient terms would only
   * be rejected downstream. Failing early is strictly better.
   *
   * Type existence is the one governance-gated dimension: a type absent from the
   * vocabulary carries no property schema, so the downstream contract can admit
   * arbitrary properties for it, and an `open` repository is meant to grow new
   * types. Under `open` an unknown type is admitted with a warning; under
   * `managed`/`locked` it fails with a pointer to the vocabulary-extension path.
   * Every other dimension — endpoint types, required properties, closed enums,
   * property-type mismatches, unknown properties, empty labels — hard-fails in
   * all modes. Errors are discriminated by their `field`, never message text.
   *
   * Retarget is the exception (see {@link checkRetargetEndpoints}): it validates
   * only the endpoint it moves. Diagnose's conformance gate maps severity to
   * governance instead, because it only reports on data that already exists and
   * cannot fail it — a deliberate, recorded difference, not drift.
   */
  private checkEntityConformance(entity: ExtractedEntity): ConformanceCheck {
    const input: CreateEntityInput = {
      entityType: entity.entityType,
      label: entity.label,
      summary: entity.summary,
      properties: entity.properties,
    };
    const result = validateEntity(input, this.vocabulary);
    if (result.valid) return { kind: 'ok' };

    const typeError = result.errors.find(e => e.field === 'entityType');
    if (typeError && result.errors.length === 1) {
      return this.resolveUnknownType('entity', typeError);
    }
    return { kind: 'fail', reason: result.errors.map(formatError).join('; ') };
  }

  private checkRelationshipConformance(
    type: string,
    properties: Record<string, unknown>,
    sourceEntityType: string,
    targetEntityType: string,
  ): ConformanceCheck {
    const input: CreateRelationshipInput = {
      relationshipType: type,
      // These id fields are unused by validateRelationship — endpoint checks use
      // the resolved-type arguments below — so they are left empty.
      sourceEntityId: '',
      targetEntityId: '',
      properties,
    };
    const result = validateRelationship(input, this.vocabulary, sourceEntityType, targetEntityType);
    if (result.valid) return { kind: 'ok' };

    const typeError = result.errors.find(e => e.field === 'relationshipType');
    if (typeError && result.errors.length === 1) {
      return this.resolveUnknownType('relationship', typeError);
    }
    return { kind: 'fail', reason: result.errors.map(formatError).join('; ') };
  }

  /**
   * Endpoint-only conformance for a retarget. Enforces the source/target type
   * constraints against the resolved endpoint types and ignores every other
   * error dimension. An edge whose relationship type is unknown cannot have its
   * endpoint constraints checked, so it is admitted with a warning.
   */
  private checkRetargetEndpoints(
    type: string,
    sourceEntityType: string,
    targetEntityType: string,
  ): ConformanceCheck {
    const input: CreateRelationshipInput = {
      // Unused by validateRelationship — resolved types are passed below.
      sourceEntityId: '',
      targetEntityId: '',
      relationshipType: type,
      properties: {},
    };
    const result = validateRelationship(input, this.vocabulary, sourceEntityType, targetEntityType);
    if (result.valid) return { kind: 'ok' };

    const typeError = result.errors.find(e => e.field === 'relationshipType');
    if (typeError) {
      return { kind: 'ok-warn', code: 'unretargetable-constraints-unknown-type', detail: formatError(typeError) };
    }
    const endpointErrors = result.errors.filter(e => e.field === 'sourceEntityId' || e.field === 'targetEntityId');
    if (endpointErrors.length > 0) {
      return { kind: 'fail', reason: endpointErrors.map(formatError).join('; ') };
    }
    // Property-dimension errors on the untouched part of the edge are ignored.
    return { kind: 'ok' };
  }

  private resolveUnknownType(scope: 'entity' | 'relationship', typeError: ValidationError): ConformanceCheck {
    if (this.mode === 'open') {
      return { kind: 'ok-warn', code: 'unknown-type-admitted', detail: formatError(typeError) };
    }
    return {
      kind: 'fail',
      reason: `${formatError(typeError)} — under '${this.mode}' governance this ${scope} type must be added through a vocabulary extension before it can be created`,
    };
  }

  // ── Recording ───────────────────────────────────────────────────────

  private record(outcome: ApplyOneOutcome, item: SelectedItem, acc: Accumulators): void {
    const { index, correction } = item;
    const source = correction.source;
    const label = correction.label;
    switch (outcome.kind) {
      case 'applied':
        acc.applied.push(outcome.ref);
        if (outcome.cascaded) acc.cascaded.push(...outcome.cascaded);
        if (outcome.warning) acc.warnings.push({ index, source, label, warning: outcome.warning.code, detail: outcome.warning.detail });
        acc.succeeded.add(index);
        break;
      case 'created':
        acc.created.push(outcome.ref);
        if (outcome.warning) acc.warnings.push({ index, source, label, warning: outcome.warning.code, detail: outcome.warning.detail });
        acc.succeeded.add(index);
        break;
      case 'retargeted':
        acc.retargeted.push(outcome.ref);
        if (outcome.warning) acc.warnings.push({ index, source, label, warning: outcome.warning.code, detail: outcome.warning.detail });
        acc.succeeded.add(index);
        break;
      case 'skipped':
        acc.skipped.push({ index, source, label, kind: outcome.category, reason: outcome.reason });
        // Idempotent skips reached the desired end-state, so they count as
        // success (and are marked approved); a not-found target does not.
        if (outcome.category !== 'not-found') acc.succeeded.add(index);
        break;
      case 'failed':
        acc.failed.push({ index, source, label, error: outcome.reason });
        break;
    }
  }

  private failAll(items: SelectedItem[], source: string, error: string, acc: Accumulators): void {
    for (const { index, correction } of items) {
      acc.failed.push({ index, source, label: correction.label, error });
    }
  }
}

// ── Module helpers ──────────────────────────────────────────────────────

function newAccumulators(): Accumulators {
  return {
    applied: [],
    created: [],
    retargeted: [],
    skipped: [],
    failed: [],
    cascaded: [],
    skippedGroups: [],
    warnings: [],
    succeeded: new Set<number>(),
  };
}

function mergeInto(target: Accumulators, src: Accumulators): void {
  target.applied.push(...src.applied);
  target.created.push(...src.created);
  target.retargeted.push(...src.retargeted);
  target.skipped.push(...src.skipped);
  target.failed.push(...src.failed);
  target.cascaded.push(...src.cascaded);
  target.skippedGroups.push(...src.skippedGroups);
  target.warnings.push(...src.warnings);
}

function warningOf(check: ConformanceCheck): WarningPayload | undefined {
  return check.kind === 'ok-warn' ? { code: check.code, detail: check.detail } : undefined;
}

/** Render a core validation error, preserving its message and suggestion verbatim. */
function formatError(error: ValidationError): string {
  return error.suggestion ? `${error.message} (${error.suggestion})` : error.message;
}

function findRelationship(
  file: ExtractionFile,
  key: RelationshipKey,
): ExtractionRelationshipRecord | undefined {
  return file.relationships.find(r => r.sourceLabel === key.sourceLabel && r.type === key.type && r.targetLabel === key.targetLabel);
}

/**
 * Case-insensitive label → entity map over an extraction file, covering labels
 * and aliases (label wins). Used to resolve relationship endpoints, mirroring
 * the conformance gate's resolution so apply-time endpoint typing agrees with
 * the diagnose-time gate.
 */
function buildEntityMap(file: ExtractionFile): Map<string, ExtractionEntityRecord> {
  const map = new Map<string, ExtractionEntityRecord>();
  for (const entity of file.entities) {
    map.set(entity.label.toLowerCase(), entity);
    for (const alias of entity.aliases ?? []) {
      const key = alias.toLowerCase();
      if (!map.has(key)) map.set(key, entity);
    }
  }
  return map;
}

function toSummaryItem(c: ProposedCorrection, index: number): CorrectionSummaryItem {
  const base: CorrectionSummaryItem = {
    index,
    source: c.source,
    itemType: c.itemType,
    operation: c.operation,
    label: c.label,
    confidence: c.confidence,
    approved: c.approved,
    remediationGroupId: c.remediationGroupId,
  };

  if (c.operation === 'update' || c.operation === 'remove-property') {
    return { ...base, property: c.property, originalValue: c.originalValue, correctedValue: c.correctedValue };
  }
  if (c.operation === 'create') {
    if (c.itemType === 'entity') {
      return { ...base, entityType: c.entity.entityType, propertyCount: Object.keys(c.entity.properties ?? {}).length };
    }
    const r = c.relationship;
    return {
      ...base,
      relationship: `${r.sourceLabel} → [${r.type}] → ${r.targetLabel}`,
      propertyCount: Object.keys(r.properties ?? {}).length,
    };
  }
  if (c.operation === 'retarget') {
    const rk = c.relationshipKey;
    const oldDisplay = `${rk.sourceLabel} →[${rk.type}]→ ${rk.targetLabel}`;
    const newSource = c.endpoint === 'source' ? c.newLabel : rk.sourceLabel;
    const newTarget = c.endpoint === 'target' ? c.newLabel : rk.targetLabel;
    return { ...base, retarget: `${oldDisplay} ⇒ ${newSource} →[${rk.type}]→ ${newTarget}` };
  }
  return base;
}

function summarizeCorrectionsByOperation(corrections: ProposedCorrection[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of corrections) {
    const key = `${c.itemType}:${c.operation}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Keep only the `keep` most recent backup set directories; delete older ones.
 * Backup set names are ISO-8601 timestamps (colons/dots replaced with dashes),
 * so lexicographic sort matches chronological order.
 */
async function pruneBackupSets(backupRoot: string, keep: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(backupRoot);
  } catch {
    return; // directory missing or unreadable — nothing to prune
  }
  if (entries.length <= keep) return;
  const sorted = [...entries].sort();
  const toDelete = sorted.slice(0, sorted.length - keep);
  for (const name of toDelete) {
    try {
      await rm(join(backupRoot, name), { recursive: true, force: true });
    } catch {
      // Non-fatal — pruning is best-effort
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
