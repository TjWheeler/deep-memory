// Input guards shared by every place that has to emit a caller-supplied name
// or count into query text rather than binding it as a parameter, plus the
// one formatter used to echo a refused value back in an error message.

/** Any runtime value a guard may be asked to describe. */
type DescribableValue = string | number | bigint | boolean | symbol | object | null | undefined;

/**
 * The regex the guards actually test against. Kept private so that nothing a
 * consumer does to the exported {@link SAFE_IDENTIFIER_PATTERN} (for example
 * calling the legacy `RegExp.prototype.compile` on it) can weaken the guards.
 * It carries no `g` / `y` flag, so `test()` is stateless.
 */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The shape a name must have before it may be emitted inline into a graph
 * query: an ASCII letter or underscore, followed by letters, digits or
 * underscores.
 *
 * Cypher and Gremlin bind values as parameters but cannot bind identifier
 * positions (property keys, relationship types, projection columns), so those
 * names are written into the query text. Restricting them to this shape means
 * a name can never close a pattern, open a clause or start a comment.
 *
 * This is a copy for consumers that want to apply or display the same rule;
 * {@link isSafeIdentifier} does not read it.
 */
export const SAFE_IDENTIFIER_PATTERN = new RegExp(IDENTIFIER_RE.source);

/**
 * True when `value` is a string matching {@link SAFE_IDENTIFIER_PATTERN}.
 *
 * The `typeof` check matters: `RegExp.prototype.test` coerces its argument,
 * so an array such as `['name']` would otherwise pass while still being
 * interpolated as something other than the checked text.
 */
export function isSafeIdentifier(value: string): boolean {
  return typeof value === 'string' && IDENTIFIER_RE.test(value);
}

/**
 * True when `value` is a number that is a safe integer of at least 1. Used
 * for repeat counts, which are emitted as literals: a fractional, non-finite
 * or non-numeric value would produce a malformed query or carry text into it.
 */
export function isPositiveSafeInteger(value: DescribableValue): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

const MAX_DESCRIBED_STRING_LENGTH = 100;

/**
 * Format a refused value for an error message without letting the message
 * become a channel for arbitrary caller content: strings are truncated and
 * JSON-quoted (so control characters and quotes are escaped), primitives are
 * printed as-is, and anything else is named by type only, never by content.
 */
export function describeRejectedValue(value: DescribableValue): string {
  if (typeof value === 'string') {
    if (value.length <= MAX_DESCRIBED_STRING_LENGTH) {
      return JSON.stringify(value);
    }
    return `${JSON.stringify(value.slice(0, MAX_DESCRIBED_STRING_LENGTH))}… (${value.length} characters)`;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  return `a value of type ${typeof value}`;
}
