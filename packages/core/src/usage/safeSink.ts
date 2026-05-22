// safeSink — wraps a UsageSink so provider code can invoke it without
// worrying that a buggy caller implementation will break the storage call.

import type { UsageSink } from '../types/usage.js';

/**
 * Wrap a sink with try/catch so a throwing caller sink never aborts the
 * underlying operation. Errors from the caller's sink are silently swallowed;
 * if the caller cares about internal failures they can catch in their own
 * implementation.
 *
 * Returns `undefined` if the input sink is `undefined`, letting providers
 * cheaply skip sink machinery when nobody is listening.
 */
export function createSafeSink(sink: UsageSink | undefined): UsageSink | undefined {
  if (!sink) return undefined;
  return (usage) => {
    try {
      sink(usage);
    } catch {
      // Deliberately swallowed — a failing caller sink must never abort the
      // provider operation it was observing.
    }
  };
}
