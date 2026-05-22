import type { ExtractedEntity } from '../types/extraction.js';
import type { RegistryEntry } from '../types/registry.js';

/** Result of matching an extracted entity against the registry */
export interface MatchResult {
  /** The matched registry entry, if found */
  match: RegistryEntry | null;
  /** Confidence score (0-1) */
  confidence: number;
  /** How the match was determined */
  matchedBy: 'exact-slug' | 'alias' | 'label-similarity' | 'none';
}

/**
 * Matches extracted entities against the entity registry for deduplication.
 *
 * Uses slug comparison, alias matching, and label similarity to identify
 * whether an extracted entity already exists in the registry.
 */
export class EntityMatcher {
  constructor(private readonly registryEntries: RegistryEntry[]) {}

  /**
   * Find the best match for an extracted entity in the registry.
   */
  match(entity: ExtractedEntity): MatchResult {
    const candidateSlug = `${entity.entityType}:${slugify(entity.label)}`;

    // 1. Exact slug match
    const slugMatch = this.registryEntries.find(e => e.slug === candidateSlug);
    if (slugMatch) {
      return { match: slugMatch, confidence: 1.0, matchedBy: 'exact-slug' };
    }

    // 2. Alias match — check if any registry entry's aliases contain the entity label
    const allLabels = [entity.label.toLowerCase(), ...entity.aliases.map(a => a.toLowerCase())];
    for (const entry of this.registryEntries) {
      if (entry.entityType !== entity.entityType) continue;
      const entryLabels = [entry.label.toLowerCase(), ...entry.aliases.map(a => a.toLowerCase())];
      for (const extracted of allLabels) {
        if (entryLabels.includes(extracted)) {
          return { match: entry, confidence: 0.9, matchedBy: 'alias' };
        }
      }
    }

    // 3. Label similarity (Jaro-Winkler) — only within same entity type
    let bestMatch: RegistryEntry | null = null;
    let bestScore = 0;
    for (const entry of this.registryEntries) {
      if (entry.entityType !== entity.entityType) continue;
      const score = jaroWinkler(entity.label.toLowerCase(), entry.label.toLowerCase());
      if (score > bestScore) {
        bestScore = score;
        bestMatch = entry;
      }
    }

    if (bestMatch && bestScore >= 0.9) {
      return { match: bestMatch, confidence: bestScore, matchedBy: 'label-similarity' };
    }

    return { match: null, confidence: 0, matchedBy: 'none' };
  }
}

// ── String Utilities ────────────────────────────────────────────────

/** Create a URL-safe slug from a label */
function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Jaro-Winkler similarity (0-1).
 * Mirrors the implementation in packages/core/src/vocabulary/similarity.ts.
 */
function jaroWinkler(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  const matchWindow = Math.max(Math.floor(Math.max(s1.length, s2.length) / 2) - 1, 0);
  const s1Matches = new Array<boolean>(s1.length).fill(false);
  const s2Matches = new Array<boolean>(s2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, s2.length);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const jaro = (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3;

  // Winkler modification: boost for common prefix (up to 4 chars)
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(s1.length, s2.length)); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}
