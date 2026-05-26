import { describe, it, expect, vi } from 'vitest';
import { CosmosDocumentClient } from './CosmosDocumentClient.js';
import { usageScope, type UsageAccumulator } from './usage.js';

// Tests for CosmosDocumentClient. The client speaks the Cosmos NoSQL REST
// protocol over fetch; these tests inject a stub fetch through the
// constructor so each test is hermetic and no globals leak between tests.

function makeResponse(init: {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  bodyText?: string;
}): Response {
  const status = init.status ?? 200;
  const headers = new Headers(init.headers ?? {});
  const bodyStr = init.bodyText ?? (init.body !== undefined ? JSON.stringify(init.body) : '');
  return new Response(bodyStr, { status, headers });
}

const baseConfig = {
  restEndpoint: 'https://host.example:8081/',
  key: Buffer.from('deadbeefdeadbeefdeadbeefdeadbeef').toString('base64'),
  database: 'deep-memory-test',
  container: 'graph-test',
  rejectUnauthorized: false,
};

describe('CosmosDocumentClient.query', () => {
  it('POSTs to /dbs/{db}/colls/{coll}/docs with the SQL body + isquery header', async () => {
    const fetchStub = vi.fn(async () =>
      makeResponse({
        body: { Documents: [{ id: 'v1' }] },
        headers: { 'x-ms-request-charge': '2.83' },
      }),
    );

    const client = new CosmosDocumentClient(baseConfig, fetchStub);
    const result = await client.query(
      'SELECT * FROM c WHERE c.repositoryId = @rid',
      [{ name: '@rid', value: 'rid-1' }],
      { partitionKey: 'rid-1' },
    );

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const callArgs = fetchStub.mock.calls[0]!;
    const url = callArgs[0] as string;
    const init = callArgs[1] as RequestInit;
    expect(url).toBe('https://host.example:8081/dbs/deep-memory-test/colls/graph-test/docs');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/query+json');
    expect(headers['x-ms-documentdb-isquery']).toBe('true');
    // partition key serialised as a JSON array of one element
    expect(headers['x-ms-documentdb-partitionkey']).toBe('["rid-1"]');
    expect(headers).not.toHaveProperty('x-ms-documentdb-query-enablecrosspartition');
    expect(init.body).toBe(
      JSON.stringify({
        query: 'SELECT * FROM c WHERE c.repositoryId = @rid',
        parameters: [{ name: '@rid', value: 'rid-1' }],
      }),
    );
    expect(result.documents).toEqual([{ id: 'v1' }]);
    expect(result.requestCharge).toBe(2.83);
    expect(result.queryMetrics).toBeNull();
    expect(result.continuationToken).toBeNull();
  });

  it('enables cross-partition when no partitionKey is supplied', async () => {
    const fetchStub = vi.fn(async () =>
      makeResponse({ body: { Documents: [] }, headers: { 'x-ms-request-charge': '0' } }),
    );
    const client = new CosmosDocumentClient(baseConfig, fetchStub);
    await client.query('SELECT VALUE COUNT(1) FROM c', [], {});
    const headers = (fetchStub.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-ms-documentdb-query-enablecrosspartition']).toBe('true');
    expect(headers).not.toHaveProperty('x-ms-documentdb-partitionkey');
  });

  it('asks for query metrics when populateMetrics is set, and returns the header', async () => {
    const fetchStub = vi.fn(async () =>
      makeResponse({
        body: { Documents: [] },
        headers: {
          'x-ms-request-charge': '1.5',
          'x-ms-documentdb-query-metrics': 'totalExecutionTimeInMs=12;indexUtilizationRatio=1.00',
        },
      }),
    );
    const client = new CosmosDocumentClient(baseConfig, fetchStub);
    const result = await client.query('SELECT * FROM c', [], { partitionKey: 'rid-1', populateMetrics: true });
    const headers = (fetchStub.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-ms-documentdb-populatequerymetrics']).toBe('true');
    expect(result.queryMetrics).toContain('indexUtilizationRatio=1.00');
  });

  it('propagates the continuation token in headers and back from response', async () => {
    const fetchStub = vi.fn(async () =>
      makeResponse({
        body: { Documents: [{ id: 'a' }] },
        headers: { 'x-ms-request-charge': '2', 'x-ms-continuation': 'cont-next' },
      }),
    );
    const client = new CosmosDocumentClient(baseConfig, fetchStub);
    const result = await client.query('SELECT * FROM c', [], {
      partitionKey: 'rid-1',
      continuationToken: 'cont-prev',
    });
    const headers = (fetchStub.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-ms-continuation']).toBe('cont-prev');
    expect(result.continuationToken).toBe('cont-next');
  });

  it('accumulates RU/calls into the active usageScope', async () => {
    const fetchStub = vi.fn(async () =>
      makeResponse({ body: { Documents: [] }, headers: { 'x-ms-request-charge': '5.5' } }),
    );
    const client = new CosmosDocumentClient(baseConfig, fetchStub);
    const acc: UsageAccumulator = { ru: 0, calls: 0, retries: 0 };
    await usageScope.run(acc, async () => {
      await client.query('SELECT * FROM c', [], { partitionKey: 'rid-1' });
      await client.query('SELECT * FROM c', [], { partitionKey: 'rid-1' });
    });
    expect(acc.ru).toBeCloseTo(11.0);
    expect(acc.calls).toBe(2);
    expect(acc.retries).toBe(0);
  });

  it('retries 429 honouring x-ms-retry-after-ms, counts the retry in usageScope, then succeeds', async () => {
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          status: 429,
          bodyText: 'throttled',
          headers: { 'x-ms-retry-after-ms': '1' },
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({ body: { Documents: [{ id: 'x' }] }, headers: { 'x-ms-request-charge': '3' } }),
      );
    const client = new CosmosDocumentClient({ ...baseConfig, maxRetries: 2 }, fetchStub);
    const acc: UsageAccumulator = { ru: 0, calls: 0, retries: 0 };
    const result = await usageScope.run(acc, () =>
      client.query('SELECT * FROM c', [], { partitionKey: 'rid-1' }),
    );
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(result.documents).toEqual([{ id: 'x' }]);
    expect(acc.calls).toBe(1);
    expect(acc.retries).toBe(1);
    expect(acc.ru).toBe(3);
  });

  it('throws after exhausting retries on persistent 429', async () => {
    const fetchStub = vi.fn(async () =>
      makeResponse({
        status: 429,
        bodyText: 'still throttled',
        headers: { 'x-ms-retry-after-ms': '1' },
      }),
    );
    const client = new CosmosDocumentClient({ ...baseConfig, maxRetries: 1 }, fetchStub);
    await expect(
      client.query('SELECT * FROM c', [], { partitionKey: 'rid-1' }),
    ).rejects.toThrow(/429/);
    expect(fetchStub).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it('throws immediately on non-transient 4xx without retrying', async () => {
    const fetchStub = vi.fn(async () =>
      makeResponse({ status: 400, bodyText: 'syntax error in query' }),
    );
    const client = new CosmosDocumentClient(baseConfig, fetchStub);
    await expect(
      client.query('SELECT BROKEN', [], { partitionKey: 'rid-1' }),
    ).rejects.toThrow(/400.*syntax error/);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe('CosmosDocumentClient.getContainerProperties', () => {
  it('GETs /dbs/{db}/colls/{coll} and returns the parsed body', async () => {
    const fetchStub = vi.fn(async () =>
      makeResponse({
        body: {
          id: 'graph-test',
          partitionKey: { paths: ['/repositoryId'], kind: 'Hash' },
          indexingPolicy: {
            indexingMode: 'consistent',
            automatic: true,
            includedPaths: [{ path: '/*' }],
            excludedPaths: [{ path: '/"_etag"/?' }],
          },
        },
      }),
    );
    const client = new CosmosDocumentClient(baseConfig, fetchStub);
    const props = await client.getContainerProperties();
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const callArgs = fetchStub.mock.calls[0]!;
    expect(callArgs[0]).toBe('https://host.example:8081/dbs/deep-memory-test/colls/graph-test');
    expect((callArgs[1] as RequestInit).method).toBe('GET');
    expect(props.indexingPolicy.includedPaths).toEqual([{ path: '/*' }]);
    expect(props.partitionKey.paths).toEqual(['/repositoryId']);
  });

  it('throws on non-OK status with status code and body', async () => {
    const fetchStub = vi.fn(async () =>
      makeResponse({ status: 404, bodyText: 'collection not found' }),
    );
    const client = new CosmosDocumentClient(baseConfig, fetchStub);
    await expect(client.getContainerProperties()).rejects.toThrow(/404.*collection not found/);
  });
});
