// LockProvider — optional distributed locking interface

/**
 * LockProvider — for multi-process or distributed deployments.
 *
 * Optional. When not provided, the core uses a no-op lock internally.
 * Used for vocabulary modifications and bulk import operations.
 */
export interface LockProvider {
  /** Acquire a named lock. Returns a handle to release it. Throws if not acquired within timeout. */
  acquire(lockName: string, options?: LockOptions): Promise<LockHandle>;
}

export interface LockOptions {
  /** Max wait to acquire in milliseconds (default 5000) */
  timeoutMs?: number;
  /** Auto-release after TTL in milliseconds (default 30000) */
  ttlMs?: number;
}

export interface LockHandle {
  release(): Promise<void>;
  extend(additionalMs: number): Promise<void>;
}
