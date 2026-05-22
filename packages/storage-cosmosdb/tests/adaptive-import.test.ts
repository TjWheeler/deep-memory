import { describe, it, expect, vi } from 'vitest';
import type {
  AdaptiveConcurrencyAdjustEvent,
  AdaptiveConcurrencyHandle,
} from '@utaba/deep-memory/types';
import { ImportThrottleAbortError } from '@utaba/deep-memory';
import {
  AdaptiveConcurrencyController,
  resolveController,
  runAdaptive,
} from '../src/queries/adaptive-import.js';
import { usageScope, type UsageAccumulator } from '../src/CosmosDbConnection.js';

describe('AdaptiveConcurrencyController', () => {
  it('starts at the configured start concurrency', () => {
    const c = new AdaptiveConcurrencyController({ start: 7, max: 32, min: 2 });
    expect(c.getConcurrency()).toBe(7);
  });

  it('defaults min to 1 — a 400 RU tier may not sustain even 2 concurrent writes', () => {
    const c = new AdaptiveConcurrencyController({ start: 4, max: 8 });
    // Halve down to floor: 4 → 2 → 1. With the previous default of 2 the
    // controller would have been stuck at 2, which can still throttle on the
    // smallest CosmosDB tiers.
    c.noteThrottle();
    c.noteThrottle();
    expect(c.getConcurrency()).toBe(1);
  });

  it('clamps start into [min, max]', () => {
    const low = new AdaptiveConcurrencyController({ start: 0, min: 2, max: 10 });
    expect(low.getConcurrency()).toBe(2);
    const high = new AdaptiveConcurrencyController({ start: 100, min: 2, max: 10 });
    expect(high.getConcurrency()).toBe(10);
  });

  it('ramps up by 1 after `increaseAfter` consecutive successes', () => {
    const events: AdaptiveConcurrencyAdjustEvent[] = [];
    const c = new AdaptiveConcurrencyController({
      start: 5,
      max: 10,
      min: 2,
      increaseAfter: 3,
      onAdjust: e => events.push(e),
    });
    c.emitStartIfNeeded();
    c.noteSuccess();
    c.noteSuccess();
    expect(c.getConcurrency()).toBe(5);
    c.noteSuccess();
    expect(c.getConcurrency()).toBe(6);
    expect(events.at(-1)).toMatchObject({
      reason: 'ramp-up',
      concurrency: 6,
      previousConcurrency: 5,
      tasksCompleted: 3,
    });
  });

  it('halves concurrency on throttle and sets a cooldown', () => {
    const events: AdaptiveConcurrencyAdjustEvent[] = [];
    const c = new AdaptiveConcurrencyController({
      start: 8,
      max: 32,
      min: 2,
      cooldownMs: 500,
      onAdjust: e => events.push(e),
    });
    c.emitStartIfNeeded();
    const before = Date.now();
    c.noteThrottle(before);
    expect(c.getConcurrency()).toBe(4);
    expect(c.getCooldownUntil()).toBe(before + 500);
    expect(c.getThrottledCount()).toBe(1);
    expect(events.at(-1)).toMatchObject({
      reason: 'throttle',
      concurrency: 4,
      previousConcurrency: 8,
      throttledCount: 1,
    });
  });

  it('does not drop below min', () => {
    const c = new AdaptiveConcurrencyController({ start: 4, max: 10, min: 3 });
    c.noteThrottle();
    expect(c.getConcurrency()).toBe(3);
    c.noteThrottle();
    expect(c.getConcurrency()).toBe(3);
  });

  it('does not exceed max', () => {
    const c = new AdaptiveConcurrencyController({
      start: 9,
      max: 10,
      min: 2,
      increaseAfter: 1,
    });
    c.noteSuccess();
    expect(c.getConcurrency()).toBe(10);
    c.noteSuccess();
    expect(c.getConcurrency()).toBe(10);
  });

  it('resets the success streak after a throttle', () => {
    const c = new AdaptiveConcurrencyController({
      start: 5,
      max: 10,
      min: 2,
      increaseAfter: 3,
      rampUpCooldownMs: 0,
    });
    c.noteSuccess();
    c.noteSuccess();
    c.noteThrottle();
    c.noteSuccess();
    c.noteSuccess();
    // Concurrency dropped to 2 on the throttle, and only 2 successes since.
    expect(c.getConcurrency()).toBe(2);
    c.noteSuccess();
    expect(c.getConcurrency()).toBe(3);
  });

  it('emits a start event exactly once', () => {
    const events: AdaptiveConcurrencyAdjustEvent[] = [];
    const c = new AdaptiveConcurrencyController({
      start: 4,
      max: 10,
      min: 2,
      onAdjust: e => events.push(e),
    });
    c.emitStartIfNeeded();
    c.emitStartIfNeeded();
    expect(events.filter(e => e.reason === 'start')).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: 'start', concurrency: 4 });
  });

  it('swallows errors thrown by the onAdjust callback', () => {
    const c = new AdaptiveConcurrencyController({
      start: 4,
      onAdjust: () => {
        throw new Error('observer crashed');
      },
    });
    expect(() => c.emitStartIfNeeded()).not.toThrow();
    expect(() => c.noteThrottle()).not.toThrow();
  });

  describe('soft ceiling', () => {
    it('records the level at which a halving throttle was observed', () => {
      const c = new AdaptiveConcurrencyController({ start: 8, max: 32, min: 2, cooldownMs: 0, rampUpCooldownMs: 0 });
      expect(c.getSoftCeiling()).toBe(Number.POSITIVE_INFINITY);
      c.noteThrottle();
      // Halved 8 → 4. The level that proved unsustainable is 8.
      expect(c.getSoftCeiling()).toBe(8);
    });

    it('does not falsely lower the ceiling on subsequent throttles in the same burst', () => {
      // First throttle halves 8 → 4 (records ceiling). The second throttle
      // halves 4 → 2 (legitimate further evidence that 4 is also bad). The
      // third throttle finds the controller already at min and does NOT
      // halve — so it must NOT overwrite the ceiling with the floor value.
      const c = new AdaptiveConcurrencyController({ start: 8, max: 32, min: 2, cooldownMs: 0, rampUpCooldownMs: 0 });
      c.noteThrottle();
      expect(c.getSoftCeiling()).toBe(8);
      c.noteThrottle();
      expect(c.getSoftCeiling()).toBe(4);
      c.noteThrottle();
      // Already at min — no halving — ceiling unchanged.
      expect(c.getSoftCeiling()).toBe(4);
    });

    it('requires multiplier × increaseAfter successes to re-attain a previously-throttled level', () => {
      // Throttle at 4 → 2 establishes a soft ceiling of 4. Going from 2 → 3
      // is below the ceiling and uses the normal increaseAfter. Going from
      // 3 → 4 is at the ceiling and should require multiplier × increaseAfter.
      const c = new AdaptiveConcurrencyController({
        start: 4,
        max: 8,
        min: 2,
        increaseAfter: 2,
        throttleCeilingMultiplier: 3,
        cooldownMs: 0,
        rampUpCooldownMs: 0,
      });
      c.noteThrottle();
      expect(c.getConcurrency()).toBe(2);
      expect(c.getSoftCeiling()).toBe(4);

      // 2 → 3: target (3) is below ceiling (4) — normal cost (2 successes).
      c.noteSuccess();
      c.noteSuccess();
      expect(c.getConcurrency()).toBe(3);

      // 3 → 4: target (4) is at the ceiling. Normal cost would be 2 — must
      // require 6 (2 × multiplier 3). Five is not enough.
      for (let i = 0; i < 5; i++) c.noteSuccess();
      expect(c.getConcurrency()).toBe(3);
      c.noteSuccess();
      expect(c.getConcurrency()).toBe(4);
    });

    it('clears the soft ceiling once successfully re-attained', () => {
      const c = new AdaptiveConcurrencyController({
        start: 4,
        max: 8,
        min: 2,
        increaseAfter: 2,
        throttleCeilingMultiplier: 3,
        cooldownMs: 0,
        rampUpCooldownMs: 0,
      });
      c.noteThrottle();
      // Push back up to the ceiling (4).
      c.noteSuccess();
      c.noteSuccess(); // 2 → 3
      for (let i = 0; i < 6; i++) c.noteSuccess(); // 3 → 4 (cautious)
      expect(c.getConcurrency()).toBe(4);
      // Held the ceiling without throttling — the constraint must drop so
      // future ramps beyond it use the normal cost.
      expect(c.getSoftCeiling()).toBe(Number.POSITIVE_INFINITY);
      // 4 → 5 now uses normal (2) successes, not 6.
      c.noteSuccess();
      c.noteSuccess();
      expect(c.getConcurrency()).toBe(5);
    });

    it('multiplier defaults to 3', () => {
      // Implicit check: with default multiplier and increaseAfter=1, going to
      // a previously-throttled level requires 3 successes.
      const c = new AdaptiveConcurrencyController({
        start: 4,
        max: 8,
        min: 2,
        increaseAfter: 1,
        cooldownMs: 0,
        rampUpCooldownMs: 0,
      });
      c.noteThrottle(); // 4 → 2, ceiling=4
      c.noteSuccess(); // 2 → 3 (below ceiling, 1 success enough)
      expect(c.getConcurrency()).toBe(3);
      c.noteSuccess(); // streak=1, target=4 (at ceiling), needs 3 — not yet
      expect(c.getConcurrency()).toBe(3);
      c.noteSuccess(); // streak=2, still not enough
      expect(c.getConcurrency()).toBe(3);
      c.noteSuccess(); // streak=3 — ramps
      expect(c.getConcurrency()).toBe(4);
    });

    it('breaks the ramp-throttle-ramp-throttle oscillation observed in dev', () => {
      // Reproduce the user-reported pattern: start=5, throttle, halve to 2,
      // ramp back to 5, throttle again. With the soft ceiling in effect the
      // re-approach should take 3× the successes it took the first time —
      // this is the protection that breaks the cycle on RU-constrained
      // tiers, not a hard cap.
      const c = new AdaptiveConcurrencyController({
        start: 5,
        max: 8,
        min: 2,
        increaseAfter: 4,
        throttleCeilingMultiplier: 3,
        cooldownMs: 0,
        rampUpCooldownMs: 0,
      });
      c.noteThrottle();
      expect(c.getConcurrency()).toBe(2);
      expect(c.getSoftCeiling()).toBe(5);

      // 2 → 3 (target<ceiling, 4 successes)
      for (let i = 0; i < 4; i++) c.noteSuccess();
      expect(c.getConcurrency()).toBe(3);
      // 3 → 4 (target<ceiling, 4 successes)
      for (let i = 0; i < 4; i++) c.noteSuccess();
      expect(c.getConcurrency()).toBe(4);
      // 4 → 5 (target===ceiling, needs 12 = 4×3). 11 is not enough.
      for (let i = 0; i < 11; i++) c.noteSuccess();
      expect(c.getConcurrency()).toBe(4);
      c.noteSuccess();
      expect(c.getConcurrency()).toBe(5);
    });
  });

  describe('ramp-up cooldown', () => {
    it('blocks streak increments until rampUpCooldownMs has elapsed after a throttle', () => {
      const t0 = Date.now();
      const c = new AdaptiveConcurrencyController({
        start: 4,
        max: 8,
        min: 2,
        increaseAfter: 2,
        cooldownMs: 0,
        rampUpCooldownMs: 5000,
      });
      c.noteThrottle(t0);
      expect(c.getConcurrency()).toBe(2);

      // Successes within the freeze window must not advance the streak.
      c.noteSuccess(t0 + 1000);
      c.noteSuccess(t0 + 2000);
      expect(c.getConcurrency()).toBe(2);

      // Once the freeze expires, normal ramp-up resumes.
      c.noteSuccess(t0 + 5001);
      c.noteSuccess(t0 + 5002);
      expect(c.getConcurrency()).toBe(3);
    });

    it('still resets consecutiveThrottlesAtMin during the freeze', () => {
      const t0 = Date.now();
      const c = new AdaptiveConcurrencyController({
        start: 2,
        max: 4,
        min: 2,
        cooldownMs: 0,
        rampUpCooldownMs: 5000,
        maxConsecutiveThrottlesAtMin: 3,
      });
      c.noteThrottle(t0);
      c.noteThrottle(t0 + 100);
      expect(c.getConsecutiveThrottlesAtMin()).toBe(2);
      // Success inside freeze: breaker streak resets but ramp stays frozen.
      c.noteSuccess(t0 + 200);
      expect(c.getConsecutiveThrottlesAtMin()).toBe(0);
      expect(c.getConcurrency()).toBe(2);
    });
  });

  describe('circuit breaker', () => {
    it('does not trip from throttles before reaching min', () => {
      // start=8, min=2: throttles at 8 -> 4 -> 2 are mid-ramp-down. Only
      // throttles AT min should count toward the breaker streak.
      const c = new AdaptiveConcurrencyController({
        start: 8,
        max: 32,
        min: 2,
        cooldownMs: 0,
        maxConsecutiveThrottlesAtMin: 3,
      });
      c.noteThrottle(); // 8 -> 4 (not at min)
      c.noteThrottle(); // 4 -> 2 (now at min — first counted)
      expect(c.shouldAbort()).toBe(false);
      expect(c.getConsecutiveThrottlesAtMin()).toBe(1);
      c.noteThrottle(); // already at min — second counted
      expect(c.shouldAbort()).toBe(false);
      c.noteThrottle(); // third — trips
      expect(c.shouldAbort()).toBe(true);
      expect(c.getConsecutiveThrottlesAtMin()).toBe(3);
    });

    it('resets the consecutive-throttle streak on any success', () => {
      const c = new AdaptiveConcurrencyController({
        start: 2,
        max: 4,
        min: 2,
        cooldownMs: 0,
        rampUpCooldownMs: 0,
        maxConsecutiveThrottlesAtMin: 3,
      });
      c.noteThrottle();
      c.noteThrottle();
      expect(c.getConsecutiveThrottlesAtMin()).toBe(2);
      c.noteSuccess();
      expect(c.getConsecutiveThrottlesAtMin()).toBe(0);
      expect(c.shouldAbort()).toBe(false);
    });

    it('honours the configured threshold', () => {
      const c = new AdaptiveConcurrencyController({
        start: 2,
        max: 4,
        min: 2,
        cooldownMs: 0,
        maxConsecutiveThrottlesAtMin: 5,
      });
      for (let i = 0; i < 4; i++) c.noteThrottle();
      expect(c.shouldAbort()).toBe(false);
      c.noteThrottle();
      expect(c.shouldAbort()).toBe(true);
    });

    it('defaults to 10 throttles at min', () => {
      const c = new AdaptiveConcurrencyController({
        start: 2,
        max: 4,
        min: 2,
        cooldownMs: 0,
      });
      expect(c.getMaxConsecutiveThrottlesAtMin()).toBe(10);
      for (let i = 0; i < 9; i++) c.noteThrottle();
      expect(c.shouldAbort()).toBe(false);
      c.noteThrottle();
      expect(c.shouldAbort()).toBe(true);
    });
  });
});

describe('resolveController', () => {
  it('returns the same controller for the same handle across calls', () => {
    // This is the core fix for the per-chunk reset bug: when RepositoryImporter
    // calls importBulk once per chunk, every call must reuse the controller so
    // it does not restart at `start` every chunk and unlearn what it has
    // discovered about the cluster's RU budget.
    const handle: AdaptiveConcurrencyHandle = {};
    const a = resolveController({ start: 7 }, handle);
    const b = resolveController({ start: 99 }, handle); // opts ignored on reuse
    expect(b).toBe(a);
    expect(a.getConcurrency()).toBe(7);
  });

  it('returns a fresh controller when no handle is supplied', () => {
    // Single-shot importBulk callers (no streaming) get a brand-new controller
    // every time — equivalent to the pre-fix behaviour, which is correct when
    // the entire import is one call.
    const a = resolveController({ start: 4 }, undefined);
    const b = resolveController({ start: 4 }, undefined);
    expect(b).not.toBe(a);
  });

  it('preserves controller state — concurrency and soft ceiling — across resolve calls', () => {
    const handle: AdaptiveConcurrencyHandle = {};
    const c1 = resolveController({ start: 4, min: 2, cooldownMs: 0 }, handle);
    c1.noteThrottle();
    expect(c1.getConcurrency()).toBe(2);
    expect(c1.getSoftCeiling()).toBe(4);
    // A second resolve call returns the same instance — state persists.
    const c2 = resolveController({ start: 4, min: 2, cooldownMs: 0 }, handle);
    expect(c2.getConcurrency()).toBe(2);
    expect(c2.getSoftCeiling()).toBe(4);
  });
});

describe('runAdaptive', () => {
  it('processes all items and returns results in input order', async () => {
    const controller = new AdaptiveConcurrencyController({ start: 3, max: 8, min: 2 });
    const items = Array.from({ length: 20 }, (_, i) => i);
    const results = await runAdaptive(items, controller, async i => i * 2);
    expect(results).toEqual(items.map(i => i * 2));
  });

  it('returns immediately for empty input', async () => {
    const controller = new AdaptiveConcurrencyController();
    const results = await runAdaptive([], controller, async () => 'x');
    expect(results).toEqual([]);
  });

  it('respects current concurrency — never more than current() in flight', async () => {
    const controller = new AdaptiveConcurrencyController({
      start: 3,
      max: 8,
      min: 2,
      increaseAfter: 1000, // never ramp during the test
    });
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 30 }, (_, i) => i);

    await runAdaptive(items, controller, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
    });

    expect(peak).toBeLessThanOrEqual(3);
  });

  it('counts retries from a nested usageScope as a throttle signal', async () => {
    // Simulate the connection layer: a task that increments retries on the
    // active usageScope and succeeds. The runner should classify this as a
    // throttle and halve concurrency.
    const events: AdaptiveConcurrencyAdjustEvent[] = [];
    const controller = new AdaptiveConcurrencyController({
      start: 8,
      max: 8,
      min: 2,
      cooldownMs: 0,
      onAdjust: e => events.push(e),
    });

    const items = [1, 2, 3];
    await runAdaptive(items, controller, async () => {
      const acc = usageScope.getStore();
      if (acc) acc.retries++;
      return 'ok';
    });

    expect(events.some(e => e.reason === 'throttle')).toBe(true);
    expect(controller.getThrottledCount()).toBe(items.length);
    // Started at 8, halved on first throttle to 4, halved again to 2, then
    // floored at min=2 for the remainder.
    expect(controller.getConcurrency()).toBe(2);
  });

  it('rolls usage counters from per-task scopes into the parent scope', async () => {
    const parent: UsageAccumulator = { ru: 0, calls: 0, retries: 0 };
    const controller = new AdaptiveConcurrencyController({ start: 3, max: 3, min: 2 });

    await usageScope.run(parent, async () => {
      await runAdaptive([1, 2, 3, 4, 5], controller, async () => {
        const acc = usageScope.getStore();
        if (acc) {
          acc.calls += 1;
          acc.ru += 7;
        }
        return 'ok';
      });
    });

    expect(parent.calls).toBe(5);
    expect(parent.ru).toBe(35);
    expect(parent.retries).toBe(0);
  });

  it('respects cooldown — no new task starts until cooldown elapses after throttle', async () => {
    // start=1 ensures only one task is in flight at a time, so the cooldown
    // gate has a chance to engage between tasks. With start>1, additional
    // workers would have already grabbed items before the first task
    // finished and reported its throttle.
    const controller = new AdaptiveConcurrencyController({
      start: 1,
      max: 1,
      min: 1,
      cooldownMs: 60,
      increaseAfter: 1000,
    });

    const startTimes: number[] = [];
    const t0 = Date.now();
    let firstDoneAt = 0;

    await runAdaptive([0, 1, 2], controller, async i => {
      startTimes.push(Date.now() - t0);
      if (i === 0) {
        const acc = usageScope.getStore();
        if (acc) acc.retries++;
        firstDoneAt = Date.now() - t0;
      }
      await new Promise(r => setTimeout(r, 5));
      return i;
    });

    // Tasks after the first must not dispatch until the cooldown has passed.
    expect(startTimes[1]! - firstDoneAt).toBeGreaterThanOrEqual(50); // slack vs 60
  });

  it('invokes onAdjust with monotonically-aging tasksCompleted', async () => {
    const events: AdaptiveConcurrencyAdjustEvent[] = [];
    const controller = new AdaptiveConcurrencyController({
      start: 5,
      max: 10,
      min: 2,
      increaseAfter: 3,
      cooldownMs: 0,
      onAdjust: e => events.push(e),
    });

    await runAdaptive(Array.from({ length: 12 }, (_, i) => i), controller, async () => 'ok');

    const completedSeq = events.map(e => e.tasksCompleted);
    for (let i = 1; i < completedSeq.length; i++) {
      expect(completedSeq[i]).toBeGreaterThanOrEqual(completedSeq[i - 1]!);
    }
    expect(events[0]).toMatchObject({ reason: 'start' });
  });

  it('does not call onAdjust at all when fully silent', async () => {
    const onAdjust = vi.fn();
    const controller = new AdaptiveConcurrencyController({ start: 3, max: 3, min: 2, onAdjust });
    await runAdaptive([1, 2, 3], controller, async () => 'ok');
    // start event always fires; ramp-up cannot fire (max == start), no throttles.
    expect(onAdjust).toHaveBeenCalledTimes(1);
    expect(onAdjust.mock.calls[0]![0]).toMatchObject({ reason: 'start' });
  });

  it('throws ImportThrottleAbortError when the circuit breaker trips', async () => {
    // start=min=2 so every throttle is at min. After 3 consecutive throttles
    // the breaker should trip and the runner should throw.
    const controller = new AdaptiveConcurrencyController({
      start: 2,
      max: 2,
      min: 2,
      cooldownMs: 0,
      maxConsecutiveThrottlesAtMin: 3,
    });

    let attempted = 0;
    const promise = runAdaptive(Array.from({ length: 100 }, (_, i) => i), controller, async () => {
      attempted++;
      const acc = usageScope.getStore();
      if (acc) acc.retries++;
      return 'ok';
    });

    await expect(promise).rejects.toBeInstanceOf(ImportThrottleAbortError);
    // Once the breaker has tripped, no further tasks dispatch — we should
    // have stopped well before the full 100.
    expect(attempted).toBeLessThan(100);
    expect(controller.shouldAbort()).toBe(true);
  });

  it('completes normally when successes reset the streak before the breaker trips', async () => {
    const controller = new AdaptiveConcurrencyController({
      start: 2,
      max: 2,
      min: 2,
      cooldownMs: 0,
      maxConsecutiveThrottlesAtMin: 3,
    });

    // Pattern: throttle, throttle, success, throttle, throttle, success, ...
    // The success after every two throttles resets the streak so the breaker
    // never reaches its threshold of 3.
    const items = Array.from({ length: 30 }, (_, i) => i);
    const results = await runAdaptive(items, controller, async i => {
      if (i % 3 !== 2) {
        const acc = usageScope.getStore();
        if (acc) acc.retries++;
      }
      return i;
    });

    expect(results).toEqual(items);
    expect(controller.shouldAbort()).toBe(false);
  });

  it('error carries diagnostic state from the moment of abort', async () => {
    const controller = new AdaptiveConcurrencyController({
      start: 2,
      max: 2,
      min: 2,
      cooldownMs: 0,
      maxConsecutiveThrottlesAtMin: 3,
    });

    let caught: ImportThrottleAbortError | undefined;
    try {
      await runAdaptive(Array.from({ length: 50 }, (_, i) => i), controller, async () => {
        const acc = usageScope.getStore();
        if (acc) acc.retries++;
        return 'ok';
      });
    } catch (err) {
      caught = err as ImportThrottleAbortError;
    }

    expect(caught).toBeInstanceOf(ImportThrottleAbortError);
    expect(caught!.concurrency).toBe(2);
    expect(caught!.consecutiveThrottlesAtMin).toBeGreaterThanOrEqual(3);
    expect(caught!.tasksCompleted).toBeGreaterThan(0);
    expect(caught!.throttledCount).toBeGreaterThanOrEqual(caught!.consecutiveThrottlesAtMin);
  });
});
