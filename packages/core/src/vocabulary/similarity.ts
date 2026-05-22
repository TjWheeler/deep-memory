// String similarity — Jaro-Winkler distance (zero dependencies)
// Used by SemanticDeduplicator as fallback when no EmbeddingProvider is available

/**
 * Compute Jaro similarity between two strings.
 * Returns a value between 0 (no similarity) and 1 (identical).
 */
export function jaroSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matchWindow = Math.max(Math.floor(Math.max(a.length, b.length) / 2) - 1, 0);

  const aMatches = new Array<boolean>(a.length).fill(false);
  const bMatches = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  // Find matches
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);

    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  // Count transpositions
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  return (
    (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3
  );
}

/**
 * Compute Jaro-Winkler similarity between two strings.
 * Gives extra weight to common prefixes (up to 4 characters).
 * Returns a value between 0 (no similarity) and 1 (identical).
 *
 * @param scalingFactor - Prefix scaling factor (default 0.1, max 0.25)
 */
export function jaroWinklerSimilarity(a: string, b: string, scalingFactor = 0.1): number {
  const jaro = jaroSimilarity(a, b);
  if (jaro === 0) return 0;

  // Common prefix length (max 4)
  const prefixLength = Math.min(4, Math.min(a.length, b.length));
  let commonPrefix = 0;
  for (let i = 0; i < prefixLength; i++) {
    if (a[i] === b[i]) {
      commonPrefix++;
    } else {
      break;
    }
  }

  return jaro + commonPrefix * Math.min(scalingFactor, 0.25) * (1 - jaro);
}

/**
 * Normalize a type name for comparison.
 * Lowercases, replaces separators with underscores, trims.
 */
export function normalizeTypeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[-\s.]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

/**
 * Convert a relationship type name to SCREAMING_SNAKE_CASE.
 * Handles camelCase, PascalCase, kebab-case, dot.case, space-separated, and existing snake_case.
 *
 * Examples:
 *   "worksOn"       → "WORKS_ON"
 *   "works-on"      → "WORKS_ON"
 *   "works_on"      → "WORKS_ON"
 *   "WORKS_ON"      → "WORKS_ON"  (idempotent)
 *   "Works On"      → "WORKS_ON"
 *   "componentOf"   → "COMPONENT_OF"
 */
export function toScreamingSnakeCase(name: string): string {
  return name
    .trim()
    // Insert underscore before uppercase letters that follow lowercase letters or digits (camelCase boundaries)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    // Insert underscore between consecutive uppercase followed by lowercase (e.g., "HTMLParser" → "HTML_Parser")
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    // Replace hyphens, spaces, dots with underscores
    .replace(/[-\s.]+/g, '_')
    // Remove any non-alphanumeric/underscore characters
    .replace(/[^A-Za-z0-9_]/g, '')
    // Collapse multiple underscores
    .replace(/_+/g, '_')
    // Remove leading/trailing underscores
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}
