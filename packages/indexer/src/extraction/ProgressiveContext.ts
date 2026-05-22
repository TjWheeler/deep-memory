import type { ExtractedEntity, ExtractedRelationship } from '../types/extraction.js';

/**
 * A compact summary of an entity, used for progressive context.
 */
export interface EntityEntry {
  entityType: string;
  label: string;
  summary: string;
  /** Most recent chapter index where this entity was seen */
  lastSeenChapter: number;
}

/**
 * A compact summary of a relationship, used for progressive context.
 */
export interface RelationshipEntry {
  type: string;
  sourceLabel: string;
  targetLabel: string;
  /** Most recent chapter index where this relationship was seen */
  lastSeenChapter: number;
}

/** Maximum character size for the serialized context to prevent prompt bloat */
const DEFAULT_MAX_CONTEXT_CHARS = 8000;

/**
 * Manages the cumulative context of previously extracted entities and relationships
 * across progressive chapter-based extraction.
 *
 * After each chapter is extracted, its results are fed into the context. The next
 * chapter's prompt includes this context so the model can reference existing entities
 * by their canonical labels.
 *
 * A recency window limits how far back the context reaches. Entities seen in multiple
 * chapters are retained longer (their lastSeenChapter is bumped on dedup).
 */
export class ProgressiveContext {
  private entities = new Map<string, EntityEntry>();
  private relationships = new Map<string, RelationshipEntry>();

  constructor(
    private readonly maxChaptersToRetain: number = 6,
    private readonly maxContextChars: number = DEFAULT_MAX_CONTEXT_CHARS,
  ) {}

  /**
   * Add entities and relationships from a completed chapter extraction.
   * Deduplicates by type+label, keeping the richer summary and bumping recency.
   */
  addChapterResults(
    chapterIndex: number,
    entities: ExtractedEntity[],
    relationships: ExtractedRelationship[],
  ): void {
    for (const entity of entities) {
      const key = `${entity.entityType}:${entity.label.toLowerCase()}`;
      const existing = this.entities.get(key);

      if (existing) {
        // Bump recency, keep the longer summary
        existing.lastSeenChapter = chapterIndex;
        if (entity.summary && entity.summary.length > existing.summary.length) {
          existing.summary = truncateSummary(entity.summary);
        }
      } else {
        this.entities.set(key, {
          entityType: entity.entityType,
          label: entity.label,
          summary: truncateSummary(entity.summary ?? ''),
          lastSeenChapter: chapterIndex,
        });
      }
    }

    for (const rel of relationships) {
      const key = `${rel.type}:${rel.sourceLabel.toLowerCase()}:${rel.targetLabel.toLowerCase()}`;
      const existing = this.relationships.get(key);

      if (existing) {
        existing.lastSeenChapter = chapterIndex;
      } else {
        this.relationships.set(key, {
          type: rel.type,
          sourceLabel: rel.sourceLabel,
          targetLabel: rel.targetLabel,
          lastSeenChapter: chapterIndex,
        });
      }
    }
  }

  /**
   * Serialize the accumulated context into a prompt section.
   * Returns empty string if no context has been accumulated.
   *
   * Applies the recency window and character limit. Oldest entries
   * beyond the window are dropped first, then entries are trimmed
   * by age until under the character limit.
   */
  toPromptSection(currentChapterIndex: number): string {
    if (this.entities.size === 0) return '';

    const cutoff = currentChapterIndex - this.maxChaptersToRetain;

    // Filter to entries within the recency window
    const recentEntities = [...this.entities.values()]
      .filter(e => e.lastSeenChapter >= cutoff)
      .sort((a, b) => a.lastSeenChapter - b.lastSeenChapter);

    const recentRels = [...this.relationships.values()]
      .filter(r => r.lastSeenChapter >= cutoff)
      .sort((a, b) => a.lastSeenChapter - b.lastSeenChapter);

    if (recentEntities.length === 0) return '';

    // Build entity lines
    const entityLines: string[] = [];
    for (const e of recentEntities) {
      const summary = e.summary ? ` — ${e.summary}` : '';
      entityLines.push(`- [${e.entityType}] "${e.label}"${summary}`);
    }

    // Build relationship lines
    const relLines: string[] = [];
    for (const r of recentRels) {
      relLines.push(`- ${r.type}: "${r.sourceLabel}" → "${r.targetLabel}"`);
    }

    let result = '## Previously Extracted Entities\n\n' + entityLines.join('\n');
    if (relLines.length > 0) {
      result += '\n\n## Previously Extracted Relationships\n\n' + relLines.join('\n');
    }

    // Trim from the beginning (oldest) if over the character limit
    while (result.length > this.maxContextChars && entityLines.length > 1) {
      entityLines.shift();
      result = '## Previously Extracted Entities\n\n' + entityLines.join('\n');
      if (relLines.length > 0) {
        result += '\n\n## Previously Extracted Relationships\n\n' + relLines.join('\n');
      }
    }

    return result;
  }

  /** Current number of tracked entities */
  get entityCount(): number {
    return this.entities.size;
  }

  /** Current number of tracked relationships */
  get relationshipCount(): number {
    return this.relationships.size;
  }

  /** Serialize the context state for checkpoint persistence */
  toJSON(): ProgressiveContextSnapshot {
    return {
      maxChaptersToRetain: this.maxChaptersToRetain,
      maxContextChars: this.maxContextChars,
      entities: [...this.entities.entries()],
      relationships: [...this.relationships.entries()],
    };
  }

  /** Restore a ProgressiveContext from a serialized checkpoint */
  static fromJSON(snapshot: ProgressiveContextSnapshot): ProgressiveContext {
    const ctx = new ProgressiveContext(snapshot.maxChaptersToRetain, snapshot.maxContextChars);
    for (const [key, entry] of snapshot.entities) {
      ctx.entities.set(key, entry);
    }
    for (const [key, entry] of snapshot.relationships) {
      ctx.relationships.set(key, entry);
    }
    return ctx;
  }
}

/** Serializable snapshot of ProgressiveContext state */
export interface ProgressiveContextSnapshot {
  maxChaptersToRetain: number;
  maxContextChars: number;
  entities: Array<[string, EntityEntry]>;
  relationships: Array<[string, RelationshipEntry]>;
}

/** Truncate a summary to a reasonable length for context injection */
function truncateSummary(summary: string, maxLength: number = 120): string {
  if (summary.length <= maxLength) return summary;
  return summary.slice(0, maxLength - 3) + '...';
}
