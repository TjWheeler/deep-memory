# CosmosDB Adaptive Import

How `@utaba/deep-memory-storage-cosmosdb` keeps bulk imports reliable on Request-Unit-constrained CosmosDB tiers.

## Why this exists

CosmosDB charges per Request Unit (RU) and throttles writes with HTTP 429 when an offered load exceeds the partition's RU budget. On autoscale tiers (e.g. 400–2000 RU/s) the cluster does **not** instantly jump to the configured maximum — it scales reactively based on observed demand. A bulk import that fires N parallel writes per chunk can easily outpace the ramp, especially at the start when the partition is sitting at the floor.

A naïve fixed-concurrency import gets into a doom loop on these tiers:

1. N parallel writes burst.
2. All N hit 429.
3. The connection layer retries with exponential backoff — **simultaneously**, because they all started at the same time.
4. Retry waves trigger another 429, and another. The cluster never gets a chance to scale up.
5. Some retries eventually exhaust their budget and the corresponding items become permanent errors.

The adaptive import runner replaces fixed concurrency with a closed-loop controller that **reduces concurrency on the first sign of throttling**, gives autoscale time to ramp, then carefully grows back when the cluster is keeping up.

## Where it lives

```
DeepMemory.importRepository(...)
  └── RepositoryImporter.importStreamCreate
        │   creates one AdaptiveConcurrencyHandle for the whole import
        └── per chunk: storage.importBulk(repositoryId, [chunk], { skipExistenceCheck, adaptiveConcurrency, adaptiveConcurrencyHandle })
              │   resolveController(handle) reuses the same controller across chunks
              └── runAdaptive(items, controller, taskFn)
                    └── per task: usageScope.run(...) → conn.submit(...) → retry on 429/503
```

The handle is what lets the controller's learned state — current concurrency, success streak, cooldown, soft ceiling — survive across the per-chunk `importBulk` calls. Without it, every chunk would create a fresh controller starting at `start`, throwing away whatever the controller had discovered about the cluster's RU budget.

| File | Purpose |
|------|---------|
| [`packages/storage-cosmosdb/src/queries/adaptive-import.ts`](../packages/storage-cosmosdb/src/queries/adaptive-import.ts) | `AdaptiveConcurrencyController`, `resolveController`, and `runAdaptive` |
| [`packages/storage-cosmosdb/src/queries/bulk.ts`](../packages/storage-cosmosdb/src/queries/bulk.ts) | `importBulk` — wires the controller around entity and relationship inserts |
| [`packages/core/src/portability/RepositoryImporter.ts`](../packages/core/src/portability/RepositoryImporter.ts) | Creates one `AdaptiveConcurrencyHandle` per import and threads it through every `importBulk` call |
| [`packages/core/src/types/portability.ts`](../packages/core/src/types/portability.ts) | `BulkImportOptions.adaptiveConcurrency`, `BulkImportOptions.adaptiveConcurrencyHandle`, `AdaptiveConcurrencyOptions`, `AdaptiveConcurrencyHandle`, `AdaptiveConcurrencyAdjustEvent` |
| [`packages/core/src/core/errors.ts`](../packages/core/src/core/errors.ts) | `ImportThrottleAbortError` (extends `ImportError`) |

## Control loop

The controller is an additive-increase / multiplicative-decrease (AIMD) loop, with a cooldown gate after each throttle and a "soft ceiling" that makes re-approaching a previously-throttled level cost more:

```
                  task throttled?
                        │
            yes ────────┼──────── no
             │                     │
   halve concurrency       streak++
   reset success streak    needed = (target ≥ softCeiling)
   set cooldown                ? increaseAfter × multiplier
   record softCeiling          : increaseAfter
   = pre-halve level       if streak ≥ needed:
             │                concurrency += 1, streak = 0
             │                if current ≥ softCeiling:
             │                    drop softCeiling
             └──────────┬──────────┘
                        ▼
              dispatch next task
              (workers gated on
               concurrency target
               + cooldown timer)
```

| Behaviour | Default | Knob |
|-----------|---------|------|
| Initial concurrency | 5 | `start` |
| Floor | 1 | `min` |
| Ceiling | 32 | `max` |
| Successes before ramp +1 (below soft ceiling) | 50 | `increaseAfter` |
| Successes before ramp +1 (at or above soft ceiling) | 150 (= 50 × 3) | `increaseAfter` × `throttleCeilingMultiplier` |
| Pause after a throttle is observed | 1000 ms | `cooldownMs` |
| Decrement on throttle | halve to `min` | (fixed) |

### Soft ceiling

When a throttle causes the controller to halve, it records the pre-halve level as a soft ceiling. Any future ramp-up whose target equals or exceeds that level requires `increaseAfter × throttleCeilingMultiplier` consecutive successes instead of `increaseAfter`. Once the controller has held that level without further throttling, the constraint is dropped — a future throttle re-establishes a new ceiling. This prevents the oscillation where the controller would ramp back up to a known-bad level, get throttled again, drop, and repeat.

The ceiling is set only on actual halving (`previous → next` where `next < previous`). Subsequent throttles in the same burst arrive at lower `current` values because the controller has already halved; those do not falsely lower the ceiling. Throttles that occur while the controller is already at `min` do not halve at all and likewise leave the ceiling untouched — the circuit breaker handles those instead.

### Floor at 1

`min` defaults to `1`, not `2`. The smallest CosmosDB autoscale tier (400 RU/s) cannot reliably sustain even two concurrent writes when the per-write cost is high relative to the tier — leaving the floor at 2 means the controller can never reach a sustainable level on those tiers and the circuit breaker trips. Operators on more generous tiers can raise `min` if they want to enforce a minimum throughput.

### Cross-call persistence

`importBulk` is called once per chunk by `RepositoryImporter`. To stop the controller from resetting at every call, RepositoryImporter creates one `AdaptiveConcurrencyHandle` (an opaque `{}`) per import and threads it through every `importBulk` call. The cosmos provider attaches the controller to that handle on first use and reuses it on subsequent calls. Direct callers of `importBulk` who issue more than one call for a single logical import should likewise pass the same handle each time; single-shot callers can ignore it.

## Detecting "this task got throttled"

`CosmosDbConnection.submit()` retries 429 and 503 internally with exponential backoff (or the server-supplied `x-ms-retry-after-ms` header). By the time a `submit` returns a result, any 429s are invisible to the caller — they were absorbed.

To get visibility back, every Gremlin submit accumulates RU charges, call counts, and **retry counts** into an async-local `UsageAccumulator`. The bulk runner wraps each task in its own nested `usageScope.run(...)` and reads the inner accumulator's `retries` field after the task finishes:

```ts
const taskAcc: UsageAccumulator = { ru: 0, calls: 0, retries: 0 };
const result = await usageScope.run(taskAcc, () => taskFn(item));
if (taskAcc.retries > 0) controller.noteThrottle();
else                     controller.noteSuccess();
// roll counts up into the parent scope so outer telemetry stays correct
parent.ru      += taskAcc.ru;
parent.calls   += taskAcc.calls;
parent.retries += taskAcc.retries;
```

A non-zero retry count is an unambiguous throttle signal — the connection layer only retries on transient (429/503) errors. Importantly, this catches **recovered** throttles as well as fatal ones, so the controller reacts before the connection's retry budget is exhausted.

## Circuit breaker

Adaptive concurrency keeps an import going when the cluster is *temporarily* overloaded. It does not solve the case where the cluster simply cannot accept the offered load at any rate — for example, a 400 RU/s tier importing into a partition where the per-write cost alone is 80 RU. In that scenario the controller bottoms out at `min` concurrency and stays there, and every task continues to throttle.

The circuit breaker detects this and aborts:

> If `maxConsecutiveThrottlesAtMin` consecutive tasks throttle while the controller is already at `min` concurrency, abort the import with `ImportThrottleAbortError`. Any successful task resets the counter.

Why "at min" and not just "many throttles in a row"? Mid-ramp-down throttles are expected — the controller is still adapting and may yet reach a sustainable level. Only throttles that occur *after* the controller has already shrunk to `min` indicate that the system is genuinely stuck.

When the breaker trips:
- No new tasks are dispatched.
- In-flight tasks are awaited (so observers see a consistent state).
- `runAdaptive` throws `ImportThrottleAbortError`. The error carries `concurrency`, `consecutiveThrottlesAtMin`, `tasksCompleted`, and `throttledCount`.
- The error propagates up through `importBulk` → `RepositoryImporter` → `DeepMemory.importRepository` to the caller. The partial import is left in place for inspection; rerunning will rely on `skipExistenceCheck=false` (merge) or replacing the repository (create).

The default `maxConsecutiveThrottlesAtMin` is **10**. With `min=1` and `cooldownMs=1000`, that is roughly 10 seconds of pure throttling at floor before aborting — enough to ride out a brief autoscale stall, short enough that an operator notices quickly.

To disable the breaker entirely, set `maxConsecutiveThrottlesAtMin: Number.MAX_SAFE_INTEGER` (or any large number).

## Configuration

```ts
import type { BulkImportOptions } from '@utaba/deep-memory/types';

const importOptions: ImportOptions = {
  target: { mode: 'create', repositoryId, config },
  bulk: {
    adaptiveConcurrency: {
      min: 1,
      start: 5,
      max: 32,
      increaseAfter: 50,
      cooldownMs: 1000,
      maxConsecutiveThrottlesAtMin: 10,
      throttleCeilingMultiplier: 3,
      onAdjust: event => console.error(`[import] ${event.reason}: ${event.previousConcurrency} -> ${event.concurrency}`),
    },
  },
};

await deepMemory.importRepository(archive, importOptions);
```

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `min` | number | 1 | Floor for the controller. Concurrency never drops below this. |
| `start` | number | 5 | Initial concurrency. Clamped into `[min, max]` if out of range. |
| `max` | number | 32 | Ceiling. Worker pool is sized to this — idle workers are free. |
| `increaseAfter` | number | 50 | Throttle-free completions before concurrency rises by 1 (when target is below the soft ceiling). |
| `throttleCeilingMultiplier` | number | 3 | Multiplier applied to `increaseAfter` when re-approaching a previously-throttled level. |
| `cooldownMs` | number | 1000 | Pause after a throttle before any further task is dispatched. |
| `maxConsecutiveThrottlesAtMin` | number | 10 | Circuit-breaker threshold. |
| `onAdjust` | `(event) => void` | — | Called on every concurrency change. Errors thrown by the callback are swallowed. |

`onAdjust` event shape:

```ts
interface AdaptiveConcurrencyAdjustEvent {
  concurrency: number;          // new level
  previousConcurrency: number;  // level before the adjustment
  reason: 'start' | 'throttle' | 'ramp-up';
  tasksCompleted: number;       // total tasks done at the moment of adjustment
  throttledCount: number;       // total tasks that observed at least one throttle
}
```

## Operator visibility (Local MCP server)

The `memory_import_repository` tool in `@utaba/deep-memory-local-mcp-server` wires `onAdjust` to its `ILogger.info` for both create and merge modes. Each adjustment is written to stderr in the form:

```
[INFO] [memory_import_repository] Adaptive concurrency start: 5 -> 5 (tasks=0, throttled=0)
[INFO] [memory_import_repository] Adaptive concurrency throttle: 5 -> 2 (tasks=12, throttled=3)
[INFO] [memory_import_repository] Adaptive concurrency ramp-up: 2 -> 3 (tasks=145, throttled=14)
```

A clean import (no throttling) shows only the `start` event. Frequent `throttle` events with no `ramp-up` between them is a sign that the RU budget is too low for the offered load — consider raising the cluster's RU tier or splitting the import into smaller chunks across time.

## Tuning guidance

| Symptom | Suggested change |
|---------|------------------|
| `ImportThrottleAbortError` after a few hundred items | RU budget is too low. Raise the autoscale ceiling, or temporarily raise `maxConsecutiveThrottlesAtMin` to push through. |
| Many `throttle` events at the start, then steady throughput | Working as intended. To save the ramp-down cost on subsequent imports, lower `start` to closer to the steady-state concurrency you observed. |
| Steady-state concurrency stays low and import is slow but reliable | Cluster is RU-constrained. Either accept the slow import or raise the RU budget. Lowering `cooldownMs` will *not* help — the bottleneck is RU, not the controller. |
| Controller never ramps up despite no throttles | Verify `increaseAfter` is reachable per chunk. With small chunks (<50 items) you may need to lower `increaseAfter` or `start` higher to begin with. |
| Want maximum throughput on a generously-provisioned cluster | Raise `max` (e.g. 64) and lower `increaseAfter` (e.g. 10). |

## Limitations

- **Create mode only.** `RepositoryImporter.importStreamMerge` performs per-entity conflict resolution using individual `getEntity`/`createEntity`/`updateEntity` calls, not `importBulk`. Those operations bypass the adaptive runner. Merge-mode imports into RU-constrained tiers will still hit the connection's plain retry path; the controller cannot help them.
- **CosmosDB-specific.** The runner lives in `@utaba/deep-memory-storage-cosmosdb`. Other storage providers (e.g. SQL Server) do not currently have an analogous controller — they don't need one because they don't throttle in the same way.
- **No per-chunk progress callback for the controller.** `onAdjust` fires only on level changes, not on every task. For per-task progress, use `RepositoryImporter`'s `onProgress` callback.
- **Circuit-breaker abort is non-transactional.** When the breaker trips, items already inserted remain in the target repository. Either retry with a tuned configuration or delete the repository and re-import.

## Testing

Unit tests for the controller and runner — fully deterministic, no CosmosDB needed — live at [`packages/storage-cosmosdb/src/queries/adaptive-import.test.ts`](../packages/storage-cosmosdb/src/queries/adaptive-import.test.ts). Conformance tests against a real CosmosDB emulator exercise the wired-up `importBulk` path.
