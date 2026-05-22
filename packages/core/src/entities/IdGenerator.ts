// IdGenerator — GUID and slug generation for entities and relationships

import { generateId } from '../core/DeepMemory.js';

/**
 * Slugify a string for use in entity slugs.
 * Lowercases, replaces non-alphanumeric with hyphens, collapses/trims hyphens.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Generate a deterministic slug from type and label.
 * Format: `{type}:{slugified-label}`
 *
 * @param entityType - The entity type (e.g., "person")
 * @param label - The entity label (e.g., "John Smith")
 * @returns Slug (e.g., "person:john-smith")
 */
export function generateSlug(entityType: string, label: string): string {
  const slug = slugify(label);
  return `${entityType}:${slug || 'unnamed'}`;
}

/**
 * Generate a unique slug, appending a suffix if the base slug already exists.
 *
 * @param entityType - The entity type
 * @param label - The entity label
 * @param existsCheck - Async function to check if a slug is already taken
 * @returns A unique slug
 */
export async function generateUniqueSlug(
  entityType: string,
  label: string,
  existsCheck: (slug: string) => Promise<boolean>,
): Promise<string> {
  const baseSlug = generateSlug(entityType, label);

  if (!(await existsCheck(baseSlug))) {
    return baseSlug;
  }

  // Append incrementing suffix until unique
  for (let i = 2; i <= 100; i++) {
    const candidateSlug = `${baseSlug}-${i}`;
    if (!(await existsCheck(candidateSlug))) {
      return candidateSlug;
    }
  }

  // Fallback: append random suffix
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  return `${baseSlug}-${randomSuffix}`;
}

/**
 * Generate a GUID for an entity.
 */
export function generateEntityId(): string {
  return generateId();
}

/**
 * Generate a GUID for a relationship.
 */
export function generateRelationshipId(): string {
  return generateId();
}
