import { describe, it, expect, vi } from 'vitest';
import { createSafeSink } from './safeSink.js';
import type { OperationUsage } from '../types/usage.js';

const sample: OperationUsage = {
  provider: 'cosmosdb',
  operation: 'getEntity',
  unit: 'RU',
  value: 2.3,
  repositoryId: '11111111-1111-1111-1111-111111111111',
  timestamp: new Date('2026-04-20T00:00:00Z'),
  details: { calls: 1, retries: 0 },
};

describe('createSafeSink', () => {
  it('returns undefined when the input sink is undefined', () => {
    expect(createSafeSink(undefined)).toBeUndefined();
  });

  it('forwards usage records to the underlying sink', () => {
    const sink = vi.fn();
    const safe = createSafeSink(sink)!;
    safe(sample);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(sample);
  });

  it('swallows errors thrown by the underlying sink', () => {
    const sink = vi.fn(() => {
      throw new Error('boom');
    });
    const safe = createSafeSink(sink)!;
    // Must not throw — a failing caller sink cannot abort the operation that
    // was trying to report its cost.
    expect(() => safe(sample)).not.toThrow();
    expect(sink).toHaveBeenCalledTimes(1);
  });
});
