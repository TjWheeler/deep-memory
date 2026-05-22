import { describe, it, expect } from 'vitest';
import { ProvenanceTracker } from './ProvenanceTracker.js';

describe('ProvenanceTracker', () => {
  const baseContext = {
    actorId: 'agent-1',
    actorType: 'agent' as const,
    conversationId: 'conv-123',
    messageId: 'msg-456',
  };

  it('stamps create provenance with all fields', () => {
    const tracker = new ProvenanceTracker(baseContext);
    const provenance = tracker.stampCreate();

    expect(provenance.createdBy).toBe('agent-1');
    expect(provenance.createdByType).toBe('agent');
    expect(provenance.createdAt).toBeTruthy();
    expect(provenance.createdInConversation).toBe('conv-123');
    expect(provenance.createdFromMessage).toBe('msg-456');
    // On create, modified fields mirror created fields
    expect(provenance.modifiedBy).toBe('agent-1');
    expect(provenance.modifiedByType).toBe('agent');
    expect(provenance.modifiedAt).toBe(provenance.createdAt);
  });

  it('stamps update provenance preserving creation fields', () => {
    const tracker = new ProvenanceTracker(baseContext);
    const created = tracker.stampCreate();

    // Change context to a different actor
    tracker.updateContext({
      actorId: 'user-2',
      actorType: 'user',
      conversationId: 'conv-789',
    });

    const updated = tracker.stampUpdate(created);

    // Creation fields preserved
    expect(updated.createdBy).toBe('agent-1');
    expect(updated.createdByType).toBe('agent');
    expect(updated.createdInConversation).toBe('conv-123');

    // Modified fields updated
    expect(updated.modifiedBy).toBe('user-2');
    expect(updated.modifiedByType).toBe('user');
    expect(updated.modifiedInConversation).toBe('conv-789');
  });

  it('updates context partially', () => {
    const tracker = new ProvenanceTracker(baseContext);
    tracker.updateContext({ messageId: 'msg-new' });

    const ctx = tracker.getContext();
    expect(ctx.actorId).toBe('agent-1'); // unchanged
    expect(ctx.messageId).toBe('msg-new'); // updated
  });

  it('returns a copy of context (not mutable reference)', () => {
    const tracker = new ProvenanceTracker(baseContext);
    const ctx1 = tracker.getContext();
    const ctx2 = tracker.getContext();
    expect(ctx1).not.toBe(ctx2);
    expect(ctx1).toEqual(ctx2);
  });

  it('handles optional fields', () => {
    const tracker = new ProvenanceTracker({
      actorId: 'agent-1',
      actorType: 'agent',
    });
    const provenance = tracker.stampCreate();
    expect(provenance.createdInConversation).toBeUndefined();
    expect(provenance.createdFromMessage).toBeUndefined();
  });
});
