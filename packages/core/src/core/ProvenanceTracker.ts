// ProvenanceTracker — automatic provenance stamping on all mutations

import type { Provenance, ProvenanceContext } from '../types/provenance.js';

/**
 * Stamps provenance metadata on entities and relationships.
 * The storage provider never needs to worry about provenance —
 * it just stores what it receives from the tracker.
 */
export class ProvenanceTracker {
  private context: ProvenanceContext;

  constructor(context: ProvenanceContext) {
    this.context = { ...context };
  }

  /** Update the active provenance context (e.g., different conversation) */
  updateContext(newContext: Partial<ProvenanceContext>): void {
    this.context = { ...this.context, ...newContext };
  }

  /** Get the current provenance context */
  getContext(): ProvenanceContext {
    return { ...this.context };
  }

  /** Stamp a newly created entity or relationship with full provenance */
  stampCreate(): Provenance {
    const now = new Date().toISOString();
    return {
      createdBy: this.context.actorId,
      createdByType: this.context.actorType,
      createdAt: now,
      createdInConversation: this.context.conversationId,
      createdFromMessage: this.context.messageId,
      modifiedBy: this.context.actorId,
      modifiedByType: this.context.actorType,
      modifiedAt: now,
      modifiedInConversation: this.context.conversationId,
      modifiedFromMessage: this.context.messageId,
    };
  }

  /** Stamp an updated entity or relationship — preserves creation fields, updates modified fields */
  stampUpdate(existing: Provenance): Provenance {
    const now = new Date().toISOString();
    return {
      ...existing,
      modifiedBy: this.context.actorId,
      modifiedByType: this.context.actorType,
      modifiedAt: now,
      modifiedInConversation: this.context.conversationId,
      modifiedFromMessage: this.context.messageId,
    };
  }
}
