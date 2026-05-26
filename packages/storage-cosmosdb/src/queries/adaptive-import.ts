// Adaptive concurrency runner for bulk imports.
//
// CosmosDB throttles writes (HTTP 429) when the autoscale tier cannot keep up
// with the offered load. The CosmosDbConnection retries 429s internally, but a
// burst of N parallel writes that all get throttled creates a retry storm that
// piles back onto an already-saturated partition. To avoid this we drive bulk
// imports through a closed-loop controller:
//
//   • Start at a conservative concurrency.
//   • Each task runs inside its own usageScope sub-accumulator. Any non-zero
//     retry count for that task means a 429 (or 503) was observed — the
//     connection only retries on transient throttle/unavailable errors.
//   • On any throttle: halve concurrency, reset the success streak, set a
//     short cooldown before any new task is dispatched. This gives autoscale
//     time to ramp.
//   • After `increaseAfter` consecutive throttle-free completions: bump
//     concurrency by 1, up to `max`.
//   • Track the highest concurrency at which a throttle was observed as a
//     "soft ceiling". Re-approaching this level requires
//     `increaseAfter * throttleCeilingMultiplier` consecutive successes
//     instead of just `increaseAfter`, so a throttle-prone level is not
//     hammered repeatedly.
//
// Sub-accumulator counts roll up into the parent usageScope on completion, so
// the outer track() telemetry continues to report correct aggregate RU/calls/
// retries for the operation as a whole.
//
// The controller is exposed for unit testing; runAdaptive is the production
// entry point used by importBulk.

import type {
  AdaptiveConcurrencyAdjustEvent,
  AdaptiveConcurrencyAdjustReason,
  AdaptiveConcurrencyHandle,
  AdaptiveConcurrencyOptions,
} from '@utaba/deep-memory/types';
import { ImportThrottleAbortError } from '@utaba/deep-memory';
import { usageScope, type UsageAccumulator } from '../usage.js';

const DEFAULT_MIN = 1;
const DEFAULT_START = 5;
const DEFAULT_MAX = 32;
const DEFAULT_INCREASE_AFTER = 50;
const DEFAULT_COOLDOWN_MS = 1000;
const DEFAULT_RAMP_UP_COOLDOWN_MS = 5000;
const DEFAULT_MAX_CONSECUTIVE_THROTTLES_AT_MIN = 10;
const DEFAULT_THROTTLE_CEILING_MULTIPLIER = 3;
// Sentinel value meaning "no soft ceiling currently in effect". Any concrete
// concurrency target below this is unconstrained; the controller only treats a
// finite softCeiling as a constraint.
const NO_SOFT_CEILING = Number.POSITIVE_INFINITY;

interface ResolvedAdaptiveOptions {
  min: number;
  start: number;
  max: number;
  increaseAfter: number;
  cooldownMs: number;
  rampUpCooldownMs: number;
  maxConsecutiveThrottlesAtMin: number;
  throttleCeilingMultiplier: number;
  onAdjust: ((event: AdaptiveConcurrencyAdjustEvent) => void) | undefined;
}

function resolveOptions(opts: AdaptiveConcurrencyOptions | undefined): ResolvedAdaptiveOptions {
  const min = Math.max(1, opts?.min ?? DEFAULT_MIN);
  const max = Math.max(min, opts?.max ?? DEFAULT_MAX);
  const start = Math.min(max, Math.max(min, opts?.start ?? DEFAULT_START));
  const increaseAfter = Math.max(1, opts?.increaseAfter ?? DEFAULT_INCREASE_AFTER);
  const cooldownMs = Math.max(0, opts?.cooldownMs ?? DEFAULT_COOLDOWN_MS);
  const rampUpCooldownMs = Math.max(0, opts?.rampUpCooldownMs ?? DEFAULT_RAMP_UP_COOLDOWN_MS);
  const maxConsecutiveThrottlesAtMin = Math.max(
    1,
    opts?.maxConsecutiveThrottlesAtMin ?? DEFAULT_MAX_CONSECUTIVE_THROTTLES_AT_MIN,
  );
  const throttleCeilingMultiplier = Math.max(
    1,
    opts?.throttleCeilingMultiplier ?? DEFAULT_THROTTLE_CEILING_MULTIPLIER,
  );
  return {
    min,
    start,
    max,
    increaseAfter,
    cooldownMs,
    rampUpCooldownMs,
    maxConsecutiveThrottlesAtMin,
    throttleCeilingMultiplier,
    onAdjust: opts?.onAdjust,
  };
}

/**
 * Internal shape of an {@link AdaptiveConcurrencyHandle} as written to by this
 * package. The handle is declared as opaque in the public API so other storage
 * providers can attach their own state without colliding.
 */
interface CosmosAdaptiveHandle extends AdaptiveConcurrencyHandle {
  controller?: AdaptiveConcurrencyController;
}

/**
 * Resolve a controller from an optional caller-supplied handle, creating one
 * on first use and reusing it on subsequent calls. This is how the controller
 * persists across multiple importBulk calls within a single import operation:
 * RepositoryImporter creates a fresh handle per import and threads it through,
 * so the controller's learned concurrency level, success streak, cooldown,
 * and soft ceiling all carry across chunks instead of resetting at each call.
 *
 * If no handle is supplied, a fresh controller is returned (single-shot use).
 */
export function resolveController(
  options: AdaptiveConcurrencyOptions | undefined,
  handle: AdaptiveConcurrencyHandle | undefined,
): AdaptiveConcurrencyController {
  if (!handle) {
    return new AdaptiveConcurrencyController(options);
  }
  const cosmosHandle = handle as CosmosAdaptiveHandle;
  if (!cosmosHandle.controller) {
    cosmosHandle.controller = new AdaptiveConcurrencyController(options);
  }
  return cosmosHandle.controller;
}

/**
 * Closed-loop concurrency controller. Stateless about tasks themselves —
 * callers feed it `noteSuccess()` and `noteThrottle()` after each task and
 * read `getConcurrency()` to decide how many tasks may be in flight.
 */
export class AdaptiveConcurrencyController {
  private readonly opts: ResolvedAdaptiveOptions;
  private current: number;
  private streak = 0;
  private cooldownUntil = 0;
  private rampFrozenUntil = 0;
  private completed = 0;
  private throttled = 0;
  private startEmitted = false;
  private consecutiveThrottlesAtMin = 0;
  /**
   * Highest concurrency at which a throttle has been observed and the
   * controller actually halved (i.e. concrete evidence the cluster could not
   * sustain that level). Re-approaching this level on subsequent ramp-ups
   * requires `increaseAfter * throttleCeilingMultiplier` consecutive successes
   * instead of just `increaseAfter`. Cleared once we've successfully held the
   * level without further throttling — see noteSuccess.
   */
  private softCeiling: number = NO_SOFT_CEILING;

  constructor(opts?: AdaptiveConcurrencyOptions) {
    this.opts = resolveOptions(opts);
    this.current = this.opts.start;
  }

  /** Current target concurrency. */
  getConcurrency(): number {
    return this.current;
  }

  /** Configured ceiling — used by the runner to size its worker pool. */
  getMaxConcurrency(): number {
    return this.opts.max;
  }

  /** Total tasks that have been noted as completed (success or throttle). */
  getCompleted(): number {
    return this.completed;
  }

  /** Total tasks that observed at least one throttle. */
  getThrottledCount(): number {
    return this.throttled;
  }

  /**
   * Earliest time (ms since epoch) at which a new task may be dispatched. Zero
   * if there is no active cooldown.
   */
  getCooldownUntil(): number {
    return this.cooldownUntil;
  }

  /**
   * Emit the initial `start` event the first time the controller is queried
   * for adjustment events. Kept separate so construction has no side effects.
   */
  emitStartIfNeeded(): void {
    if (this.startEmitted) return;
    this.startEmitted = true;
    this.notify('start', this.current);
  }

  /** Record a throttle-free task completion. May trigger ramp-up. */
  noteSuccess(now: number = Date.now()): void {
    this.completed++;
    this.consecutiveThrottlesAtMin = 0;
    if (now < this.rampFrozenUntil) return;
    this.streak++;
    if (this.current >= this.opts.max) return;
    const target = this.current + 1;
    // Re-approaching a previously-throttled level requires more sustained
    // success — multiplier × increaseAfter — so the controller does not
    // hammer a level the cluster has already proven it cannot sustain.
    const needed =
      target >= this.softCeiling
        ? this.opts.increaseAfter * this.opts.throttleCeilingMultiplier
        : this.opts.increaseAfter;
    if (this.streak >= needed) {
      const previous = this.current;
      this.current = Math.min(this.opts.max, target);
      this.streak = 0;
      // We've cautiously re-attained (or exceeded) the soft ceiling without
      // further throttling. Drop the constraint — subsequent ramp-ups beyond
      // this level use the normal increaseAfter. A future throttle will
      // re-establish a new ceiling.
      if (this.current >= this.softCeiling) {
        this.softCeiling = NO_SOFT_CEILING;
      }
      this.notify('ramp-up', previous);
    }
  }

  /** Record a task that observed at least one throttle. Halves concurrency. */
  noteThrottle(now: number = Date.now()): void {
    this.completed++;
    this.throttled++;
    this.streak = 0;
    const previous = this.current;
    const next = Math.max(this.opts.min, Math.floor(this.current / 2));
    this.cooldownUntil = now + this.opts.cooldownMs;
    this.rampFrozenUntil = now + this.opts.rampUpCooldownMs;
    if (next !== previous) {
      this.current = next;
      // Record this level as a soft ceiling. Only update on actual halving so
      // that subsequent throttles in the same burst (which arrive at lower
      // current values because we already halved) do not falsely lower the
      // ceiling.
      this.softCeiling = previous;
      this.notify('throttle', previous);
    }
    // Track throttles that occur while the controller is already at floor.
    // Mid-ramp-down throttles do not contribute — the controller is still
    // adapting and may yet reach a sustainable level. The streak increments
    // only when the post-throttle concurrency equals min (i.e. we are stuck
    // at the floor and the cluster still cannot accept the load).
    if (this.current === this.opts.min) {
      this.consecutiveThrottlesAtMin++;
    } else {
      this.consecutiveThrottlesAtMin = 0;
    }
  }

  /**
   * Current soft ceiling — the highest concurrency at which a throttle was
   * observed and the controller halved. {@link Number.POSITIVE_INFINITY} when
   * no ceiling is in effect. Re-approaching this level requires
   * `increaseAfter * throttleCeilingMultiplier` consecutive successes.
   */
  getSoftCeiling(): number {
    return this.softCeiling;
  }

  /** Configured circuit-breaker threshold. */
  getMaxConsecutiveThrottlesAtMin(): number {
    return this.opts.maxConsecutiveThrottlesAtMin;
  }

  /** How many consecutive throttles have occurred at min. */
  getConsecutiveThrottlesAtMin(): number {
    return this.consecutiveThrottlesAtMin;
  }

  /**
   * Whether the circuit breaker has tripped — runner should stop dispatching
   * new tasks and surface an `ImportThrottleAbortError` to the caller.
   */
  shouldAbort(): boolean {
    return this.consecutiveThrottlesAtMin >= this.opts.maxConsecutiveThrottlesAtMin;
  }

  private notify(reason: AdaptiveConcurrencyAdjustReason, previous: number): void {
    const cb = this.opts.onAdjust;
    if (!cb) return;
    try {
      cb({
        concurrency: this.current,
        previousConcurrency: previous,
        reason,
        tasksCompleted: this.completed,
        throttledCount: this.throttled,
      });
    } catch {
      // Operator callback errors are swallowed by design.
    }
  }
}

/**
 * Run a task inside a nested usageScope so its retries/RU/calls can be
 * inspected independently of any outer scope. Roll the inner counters up into
 * the parent (if any) on completion so outer telemetry remains correct.
 *
 * Returns the task result and the number of retries observed inside the task.
 * A non-zero retry count means the connection layer observed a 429/503 for
 * one of this task's submits, which the adaptive controller treats as a
 * throttle signal — even if the retry ultimately succeeded.
 */
async function runTaskWithUsage<R>(fn: () => Promise<R>): Promise<{ result: R; retries: number }> {
  const parent = usageScope.getStore();
  const taskAcc: UsageAccumulator = { ru: 0, calls: 0, retries: 0 };
  try {
    const result = await usageScope.run(taskAcc, fn);
    return { result, retries: taskAcc.retries };
  } finally {
    if (parent) {
      parent.ru += taskAcc.ru;
      parent.calls += taskAcc.calls;
      parent.retries += taskAcc.retries;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Adaptive runner — processes `items` with dynamic concurrency, returning
 * results in input order. Mirrors the contract of the previous fixed-size
 * runWithConcurrency so callers swap one for the other.
 *
 * The runner respects the controller's cooldown: when a throttle has just
 * been observed, no new task is dispatched until the cooldown elapses, even
 * if a worker slot is otherwise free. In-flight tasks are unaffected.
 *
 * Throws {@link ImportThrottleAbortError} if the controller's circuit breaker
 * trips (sustained throttling at minimum concurrency). In-flight tasks are
 * awaited before the throw so observers see consistent state, but no new
 * tasks are dispatched once the breaker has tripped.
 */
export async function runAdaptive<T, R>(
  items: T[],
  controller: AdaptiveConcurrencyController,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  controller.emitStartIfNeeded();

  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let inFlight = 0;
  let aborted = false;

  // Workers wait on `gate` when they cannot dispatch (cooldown active, all
  // slots taken, or the breaker has tripped and we are draining). Any state
  // change re-issues the gate so all waiters wake up and re-check.
  let gate = createGate();

  function pokeGate(): void {
    const old = gate;
    gate = createGate();
    old.resolve();
  }

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      if (aborted) return;
      // Wait until both: a slot is free AND any active cooldown has elapsed.
      while (true) {
        if (aborted || nextIndex >= items.length) return;
        const cooldownRemaining = controller.getCooldownUntil() - Date.now();
        const slotsAvailable = inFlight < controller.getConcurrency();
        if (cooldownRemaining <= 0 && slotsAvailable) break;
        if (cooldownRemaining > 0) {
          await Promise.race([sleep(cooldownRemaining), gate.promise]);
        } else {
          await gate.promise;
        }
      }
      if (aborted || nextIndex >= items.length) return;

      const idx = nextIndex++;
      inFlight++;
      try {
        const { result, retries } = await runTaskWithUsage(() => fn(items[idx]!));
        results[idx] = result;
        if (retries > 0) {
          controller.noteThrottle();
        } else {
          controller.noteSuccess();
        }
        if (controller.shouldAbort()) {
          aborted = true;
        }
      } finally {
        inFlight--;
        pokeGate();
      }
    }
  }

  // Provision workers up to the configured ceiling so the controller has
  // headroom to ramp up. Idle workers cost nothing — they just await the
  // gate. We never spawn more workers than items.
  const workerCount = Math.min(items.length, controller.getMaxConcurrency());
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  if (aborted) {
    throw new ImportThrottleAbortError(
      controller.getConcurrency(),
      controller.getConsecutiveThrottlesAtMin(),
      controller.getCompleted(),
      controller.getThrottledCount(),
    );
  }

  return results;
}

function createGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}
