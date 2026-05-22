// EventBus — zero-dependency typed event emitter

import type {
  DeepMemoryEvent,
  DeepMemoryEventType,
  EventHandler,
  EventPayload,
  HookResult,
  Unsubscribe,
} from '../types/events.js';
import type { ProvenanceContext } from '../types/provenance.js';

/** Pre-mutation event types (those ending in "ing") */
type PreMutationEvent = Extract<
  DeepMemoryEventType,
  'entity:creating' | 'entity:updating' | 'entity:deleting' |
  'relationship:creating' | 'relationship:removing'
>;

/** Hook handler that can cancel or modify operations */
export type HookHandler<T extends PreMutationEvent> = (
  event: DeepMemoryEvent<T>,
) => HookResult | Promise<HookResult>;

export class EventBus {
  private handlers = new Map<string, Set<EventHandler<any>>>();
  private hookHandlers = new Map<string, Set<HookHandler<any>>>();
  private provenance: ProvenanceContext;
  private repositoryId?: string;

  constructor(provenance: ProvenanceContext, repositoryId?: string) {
    this.provenance = provenance;
    this.repositoryId = repositoryId;
  }

  /** Update provenance context (e.g., when conversation changes) */
  updateProvenance(provenance: ProvenanceContext): void {
    this.provenance = provenance;
  }

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<E extends DeepMemoryEventType>(event: E, handler: EventHandler<E>): Unsubscribe {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);

    return () => {
      this.handlers.get(event)?.delete(handler);
    };
  }

  /** Register a pre-mutation hook that can cancel operations */
  onHook<E extends PreMutationEvent>(event: E, handler: HookHandler<E>): Unsubscribe {
    if (!this.hookHandlers.has(event)) {
      this.hookHandlers.set(event, new Set());
    }
    this.hookHandlers.get(event)!.add(handler);

    return () => {
      this.hookHandlers.get(event)?.delete(handler);
    };
  }

  /** Emit an event to all registered handlers */
  async emit<E extends DeepMemoryEventType>(
    event: E,
    payload: EventPayload<E>,
  ): Promise<void> {
    const handlers = this.handlers.get(event);
    if (!handlers || handlers.size === 0) return;

    const eventObj: DeepMemoryEvent<E> = {
      type: event,
      timestamp: new Date().toISOString(),
      repositoryId: this.repositoryId,
      provenance: { ...this.provenance },
      payload,
    };

    for (const handler of handlers) {
      await handler(eventObj);
    }
  }

  /**
   * Emit a pre-mutation hook event.
   * Returns `{ cancelled: false }` if all hooks pass,
   * or `{ cancelled: true, reason }` if any hook cancels.
   */
  async emitHook<E extends PreMutationEvent>(
    event: E,
    payload: EventPayload<E>,
  ): Promise<{ cancelled: boolean; reason?: string }> {
    const hooks = this.hookHandlers.get(event);
    if (!hooks || hooks.size === 0) return { cancelled: false };

    const eventObj: DeepMemoryEvent<E> = {
      type: event,
      timestamp: new Date().toISOString(),
      repositoryId: this.repositoryId,
      provenance: { ...this.provenance },
      payload,
    };

    for (const hook of hooks) {
      const result = await hook(eventObj);
      if (result.cancel) {
        return { cancelled: true, reason: result.reason };
      }
    }

    return { cancelled: false };
  }

  /** Remove all listeners and hooks */
  removeAllListeners(): void {
    this.handlers.clear();
    this.hookHandlers.clear();
  }
}
