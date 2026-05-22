import { describe, it, expect, vi } from 'vitest';
import { EventBus } from './EventBus.js';

const provenance = { actorId: 'test', actorType: 'agent' as const };

describe('EventBus', () => {
  describe('on / emit', () => {
    it('fires handler for matching event', async () => {
      const bus = new EventBus(provenance, 'repo-1');
      const handler = vi.fn();

      bus.on('entity:created', handler);
      await bus.emit('entity:created', {
        entity: { id: 'e1', slug: 'tim', entityType: 'person', label: 'Tim', properties: {}, provenance: {} as any },
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0]![0].type).toBe('entity:created');
      expect(handler.mock.calls[0]![0].repositoryId).toBe('repo-1');
    });

    it('does not fire handler for non-matching event', async () => {
      const bus = new EventBus(provenance);
      const handler = vi.fn();

      bus.on('entity:created', handler);
      await bus.emit('entity:deleted', { ids: ['e1'] });

      expect(handler).not.toHaveBeenCalled();
    });

    it('fires multiple handlers in order', async () => {
      const bus = new EventBus(provenance);
      const order: number[] = [];

      bus.on('entity:deleted', () => { order.push(1); });
      bus.on('entity:deleted', () => { order.push(2); });
      bus.on('entity:deleted', () => { order.push(3); });

      await bus.emit('entity:deleted', { ids: ['e1'] });
      expect(order).toEqual([1, 2, 3]);
    });

    it('includes timestamp and provenance in event', async () => {
      const bus = new EventBus(provenance);
      const handler = vi.fn();

      bus.on('entity:deleted', handler);
      await bus.emit('entity:deleted', { ids: ['e1'] });

      const event = handler.mock.calls[0]![0];
      expect(event.timestamp).toBeTruthy();
      expect(event.provenance.actorId).toBe('test');
    });
  });

  describe('unsubscribe', () => {
    it('stops receiving events after unsubscribe', async () => {
      const bus = new EventBus(provenance);
      const handler = vi.fn();

      const unsub = bus.on('entity:created', handler);
      unsub();

      await bus.emit('entity:created', {
        entity: { id: 'e1', slug: 'tim', entityType: 'person', label: 'Tim', properties: {}, provenance: {} as any },
      });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('removeAllListeners', () => {
    it('removes all handlers and hooks', async () => {
      const bus = new EventBus(provenance);
      const handler = vi.fn();
      const hook = vi.fn().mockReturnValue({ cancel: false });

      bus.on('entity:created', handler);
      bus.onHook('entity:creating', hook);
      bus.removeAllListeners();

      await bus.emit('entity:created', {
        entity: { id: 'e1', slug: 'tim', entityType: 'person', label: 'Tim', properties: {}, provenance: {} as any },
      });
      await bus.emitHook('entity:creating', { input: {} as any });

      expect(handler).not.toHaveBeenCalled();
      expect(hook).not.toHaveBeenCalled();
    });
  });

  describe('hooks', () => {
    it('returns not cancelled when no hooks', async () => {
      const bus = new EventBus(provenance);
      const result = await bus.emitHook('entity:creating', { input: {} as any });
      expect(result.cancelled).toBe(false);
    });

    it('returns not cancelled when hook allows', async () => {
      const bus = new EventBus(provenance);
      bus.onHook('entity:creating', () => ({ cancel: false }));

      const result = await bus.emitHook('entity:creating', { input: {} as any });
      expect(result.cancelled).toBe(false);
    });

    it('returns cancelled when hook cancels', async () => {
      const bus = new EventBus(provenance);
      bus.onHook('entity:creating', () => ({
        cancel: true,
        reason: 'Not allowed',
      }));

      const result = await bus.emitHook('entity:creating', { input: {} as any });
      expect(result.cancelled).toBe(true);
      expect(result.reason).toBe('Not allowed');
    });

    it('stops at first cancelling hook', async () => {
      const bus = new EventBus(provenance);
      const hook1 = vi.fn().mockReturnValue({ cancel: true, reason: 'First' });
      const hook2 = vi.fn().mockReturnValue({ cancel: false });

      bus.onHook('entity:creating', hook1);
      bus.onHook('entity:creating', hook2);

      const result = await bus.emitHook('entity:creating', { input: {} as any });
      expect(result.cancelled).toBe(true);
      expect(result.reason).toBe('First');
      expect(hook2).not.toHaveBeenCalled();
    });

    it('supports async hook handlers', async () => {
      const bus = new EventBus(provenance);
      bus.onHook('entity:deleting', async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { cancel: true, reason: 'Async deny' };
      });

      const result = await bus.emitHook('entity:deleting', { ids: ['e1'] });
      expect(result.cancelled).toBe(true);
      expect(result.reason).toBe('Async deny');
    });

    it('hook unsubscribe works', async () => {
      const bus = new EventBus(provenance);
      const hook = vi.fn().mockReturnValue({ cancel: true, reason: 'Blocked' });

      const unsub = bus.onHook('entity:creating', hook);
      unsub();

      const result = await bus.emitHook('entity:creating', { input: {} as any });
      expect(result.cancelled).toBe(false);
      expect(hook).not.toHaveBeenCalled();
    });
  });
});
