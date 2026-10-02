// Unit tests for how CosmosDbConnection reads Cosmos status from Gremlin
// driver errors: which failures are retried, how long it waits, and that a
// 412 (lost optimistic-concurrency race) reaches the caller instead of being
// retried.

import { describe, it, expect } from 'vitest';
import {
  CosmosDbConnection,
  cosmosStatusCode,
  getRetryAfterMs,
  isTransientError,
  parseTimeSpanMs,
} from './CosmosDbConnection.js';

/** Shape of the gremlin driver's ResponseError for a Cosmos-side failure. */
function responseError(attributes: Record<string, unknown> | Map<string, unknown>, message = 'Server error (500)'): Error {
  return Object.assign(new Error(message), { statusCode: 500, statusAttributes: attributes });
}

describe('cosmosStatusCode', () => {
  it('reads x-ms-status-code from a plain-object attribute bag', () => {
    expect(cosmosStatusCode(responseError({ 'x-ms-status-code': 412 }))).toBe(412);
  });

  it('reads x-ms-status-code from a Map attribute bag', () => {
    expect(cosmosStatusCode(responseError(new Map([['x-ms-status-code', 429]])))).toBe(429);
  });

  it('accepts a numeric string', () => {
    expect(cosmosStatusCode(responseError({ 'x-ms-status-code': '404' }))).toBe(404);
  });

  it('is undefined when the error carries no Cosmos status', () => {
    expect(cosmosStatusCode(new Error('socket hang up'))).toBeUndefined();
    expect(cosmosStatusCode(responseError({}))).toBeUndefined();
    expect(cosmosStatusCode(null)).toBeUndefined();
  });
});

describe('isTransientError', () => {
  it('retries 429 and 503 reported in the status attributes', () => {
    expect(isTransientError(responseError({ 'x-ms-status-code': 429 }))).toBe(true);
    expect(isTransientError(responseError({ 'x-ms-status-code': 503 }))).toBe(true);
  });

  it('never retries a 412 or 404, even when the message mentions a transient code', () => {
    expect(isTransientError(responseError({ 'x-ms-status-code': 412 }, 'RequestRateTooLarge 429'))).toBe(false);
    expect(isTransientError(responseError({ 'x-ms-status-code': 404 }))).toBe(false);
  });

  it('falls back to the message and statusCode when no Cosmos status is present', () => {
    expect(isTransientError(new Error('RequestRateTooLarge'))).toBe(true);
    expect(isTransientError(new Error('ServiceUnavailable'))).toBe(true);
    expect(isTransientError(Object.assign(new Error('x'), { statusCode: 429 }))).toBe(true);
    expect(isTransientError(new Error('Gremlin syntax error'))).toBe(false);
  });
});

describe('parseTimeSpanMs', () => {
  it('parses the .NET TimeSpan form Cosmos uses for x-ms-retry-after-ms', () => {
    expect(parseTimeSpanMs('00:00:00.0050000')).toBe(5);
    expect(parseTimeSpanMs('00:00:01.2500000')).toBe(1250);
    expect(parseTimeSpanMs('00:01:00')).toBe(60_000);
    expect(parseTimeSpanMs('1.00:00:00')).toBe(86_400_000);
  });

  it('takes a plain number as milliseconds', () => {
    expect(parseTimeSpanMs(250)).toBe(250);
    expect(parseTimeSpanMs('250')).toBe(250);
  });

  it('is undefined for anything else', () => {
    expect(parseTimeSpanMs('soon')).toBeUndefined();
    expect(parseTimeSpanMs('')).toBeUndefined();
    expect(parseTimeSpanMs(undefined)).toBeUndefined();
    expect(parseTimeSpanMs(-1)).toBeUndefined();
  });
});

describe('getRetryAfterMs', () => {
  it('prefers the server-supplied x-ms-retry-after-ms', () => {
    const err = responseError({ 'x-ms-status-code': 429, 'x-ms-retry-after-ms': '00:00:00.0420000' });
    expect(getRetryAfterMs(err, 0)).toBe(42);
  });

  it('falls back to exponential backoff', () => {
    expect(getRetryAfterMs(responseError({ 'x-ms-status-code': 429 }), 0)).toBe(500);
    expect(getRetryAfterMs(responseError({ 'x-ms-status-code': 429 }), 2)).toBe(2000);
    expect(getRetryAfterMs(new Error('x'), 10)).toBe(10000);
  });
});

describe('CosmosDbConnection.submit retry behaviour', () => {
  function connectionWith(
    submit: () => Promise<{ toArray(): unknown[]; attributes: Record<string, unknown> }>,
  ): { conn: CosmosDbConnection; attempts: () => number } {
    const conn = new CosmosDbConnection({
      endpoint: 'ws://unit-test/',
      key: 'k',
      database: 'd',
      container: 'c',
      maxRetries: 3,
    });
    let attempts = 0;
    // Bracket-access to install a fake driver client; no socket is opened.
    (conn as unknown as { client: { submit: () => Promise<unknown> } }).client = {
      submit: () => {
        attempts++;
        return submit();
      },
    };
    return { conn, attempts: () => attempts };
  }

  it('surfaces a 412 on the first attempt without retrying', async () => {
    const { conn, attempts } = connectionWith(async () => {
      throw responseError({ 'x-ms-status-code': 412 });
    });

    await expect(conn.submit('g.V()')).rejects.toMatchObject({
      statusAttributes: { 'x-ms-status-code': 412 },
    });
    expect(attempts()).toBe(1);
  });

  it('retries a 429 after the server-supplied delay, then returns the result', async () => {
    let calls = 0;
    const { conn, attempts } = connectionWith(async () => {
      calls++;
      if (calls === 1) {
        throw responseError({ 'x-ms-status-code': 429, 'x-ms-retry-after-ms': '00:00:00.0010000' });
      }
      return { toArray: () => [7], attributes: {} };
    });

    const result = await conn.submit('g.V().count()');
    expect(result.items).toEqual([7]);
    expect(attempts()).toBe(2);
  });
});
