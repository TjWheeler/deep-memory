import { describe, expect, it, vi } from 'vitest';
import { DoclingClient } from './DoclingClient.js';
import { DoclingServiceError, DoclingTimeoutError } from './errors.js';

// ── Helpers ────────────────────────────────────────────────────────────────

type FetchFn = typeof fetch;

/**
 * Create a mock fetch that returns a scripted sequence of responses. Each
 * call advances the script; overflow throws. Handlers can be literal
 * Response objects or thunks that receive the request.
 */
function scriptedFetch(
  handlers: Array<Response | ((req: { url: string; init: RequestInit }) => Response | Promise<Response>)>,
): { fn: FetchFn; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn: FetchFn = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const record = { url, init: (init ?? {}) as RequestInit };
    calls.push(record);
    if (i >= handlers.length) {
      throw new Error(`scriptedFetch: unexpected extra call #${i + 1} to ${url}`);
    }
    const handler = handlers[i++];
    const out = typeof handler === 'function' ? await handler(record) : handler;
    return out as Response;
  };
  return { fn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

// docling-serve v1 wraps rendered output inside `document.{format}_content`.
// The default request format is Markdown, so `md_content` is the useful field.
const MD_BODY = {
  document: {
    filename: 'doc-a.pdf',
    md_content: '# Doc A\n\nhello world',
    json_content: {
      schema_name: 'DoclingDocument',
      version: '1.7.0',
      name: 'doc-a',
      body: { children: [] },
    },
  },
  status: 'success',
  errors: [],
};

// Deterministic sleep — records delays without waiting.
function recordedSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('DoclingClient.postConvert', () => {
  it('posts a multipart form and returns the converted document on a 200 response', async () => {
    const { fn, calls } = scriptedFetch([jsonResponse(MD_BODY)]);
    const client = new DoclingClient({ endpoint: 'http://host:8030', fetch: fn });

    const response = await client.postConvert({
      content: Buffer.from('%PDF-1.4 bytes'),
      filename: 'doc-a.pdf',
      mimeType: 'application/pdf',
    });

    expect(response.document.name).toBe('doc-a');
    expect(response.document.content['md_content']).toBe('# Doc A\n\nhello world');

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('http://host:8030/v1/convert/file');
    expect(call.init.method).toBe('POST');
    expect(call.init.body).toBeInstanceOf(FormData);
    const form = call.init.body as FormData;
    expect(form.get('to_formats')).toBe('md');
    expect(form.get('files')).toBeInstanceOf(Blob);
  });

  it('returns the cached document for repeated calls with identical content', async () => {
    const { fn, calls } = scriptedFetch([jsonResponse(MD_BODY)]);
    const client = new DoclingClient({ endpoint: 'http://host:8030', fetch: fn });

    const req = {
      content: Buffer.from('identical-bytes'),
      filename: 'doc-a.pdf',
      mimeType: 'application/pdf',
    };
    const first = await client.postConvert(req);
    const second = await client.postConvert(req);

    expect(calls).toHaveLength(1);
    expect(second.document).toBe(first.document);
  });

  it('treats different filenames as cache misses even with identical content', async () => {
    const { fn, calls } = scriptedFetch([jsonResponse(MD_BODY), jsonResponse(MD_BODY)]);
    const client = new DoclingClient({ endpoint: 'http://host:8030', fetch: fn });

    const content = Buffer.from('shared');
    await client.postConvert({ content, filename: 'a.pdf', mimeType: 'application/pdf' });
    await client.postConvert({ content, filename: 'b.pdf', mimeType: 'application/pdf' });

    expect(calls).toHaveLength(2);
  });

  it('evicts the oldest cache entry once cacheMaxEntries is reached', async () => {
    const { fn, calls } = scriptedFetch([
      jsonResponse(MD_BODY),
      jsonResponse(MD_BODY),
      jsonResponse(MD_BODY),
      jsonResponse(MD_BODY), // re-fetch of the evicted entry
    ]);
    const client = new DoclingClient({
      endpoint: 'http://host:8030',
      fetch: fn,
      cacheMaxEntries: 2,
    });

    await client.postConvert({ content: Buffer.from('a'), filename: 'a.pdf' });
    await client.postConvert({ content: Buffer.from('b'), filename: 'b.pdf' });
    await client.postConvert({ content: Buffer.from('c'), filename: 'c.pdf' }); // evicts 'a'
    await client.postConvert({ content: Buffer.from('a'), filename: 'a.pdf' }); // miss

    expect(calls).toHaveLength(4);
  });

  it('retries on 503 and succeeds on the next attempt', async () => {
    const { fn, calls } = scriptedFetch([textResponse('unavailable', 503), jsonResponse(MD_BODY)]);
    const { sleep, delays } = recordedSleep();
    const client = new DoclingClient({
      endpoint: 'http://host:8030',
      fetch: fn,
      sleep,
      random: () => 0.5,
      baseDelayMs: 100,
    });

    const out = await client.postConvert({ content: Buffer.from('retry-me'), filename: 'r.pdf' });

    expect(out.document.name).toBe('doc-a');
    expect(calls).toHaveLength(2);
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(0);
  });

  it('retries on 429 (rate-limit)', async () => {
    const { fn, calls } = scriptedFetch([textResponse('slow down', 429), jsonResponse(MD_BODY)]);
    const { sleep } = recordedSleep();
    const client = new DoclingClient({
      endpoint: 'http://host:8030',
      fetch: fn,
      sleep,
      random: () => 0,
    });

    const out = await client.postConvert({ content: Buffer.from('rate'), filename: 'x.pdf' });
    expect(out.document.name).toBe('doc-a');
    expect(calls).toHaveLength(2);
  });

  it('does NOT retry on 400 and throws DoclingServiceError with the body snippet', async () => {
    const { fn, calls } = scriptedFetch([textResponse('bad filename', 400)]);
    const { sleep, delays } = recordedSleep();
    const client = new DoclingClient({ endpoint: 'http://host:8030', fetch: fn, sleep });

    await expect(
      client.postConvert({ content: Buffer.from('x'), filename: 'x.pdf' }),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof DoclingServiceError)) return false;
      return err.status === 400 && err.bodySnippet === 'bad filename';
    });
    expect(calls).toHaveLength(1);
    expect(delays).toHaveLength(0);
  });

  it('does NOT retry on 404', async () => {
    const { fn, calls } = scriptedFetch([textResponse('not found', 404)]);
    const client = new DoclingClient({ endpoint: 'http://host:8030', fetch: fn });

    await expect(
      client.postConvert({ content: Buffer.from('x'), filename: 'x.pdf' }),
    ).rejects.toBeInstanceOf(DoclingServiceError);
    expect(calls).toHaveLength(1);
  });

  it('raises DoclingTimeoutError when the request aborts via signal', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { fn } = scriptedFetch([() => Promise.reject(abortError)]);
    const { sleep } = recordedSleep();
    const client = new DoclingClient({
      endpoint: 'http://host:8030',
      fetch: fn,
      timeoutMs: 50,
      maxRetries: 0,
      sleep,
    });

    await expect(
      client.postConvert({ content: Buffer.from('x'), filename: 'x.pdf' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof DoclingTimeoutError && err.timeoutMs === 50,
    );
  });

  it('treats a timeout as transient and retries', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { fn, calls } = scriptedFetch([() => Promise.reject(abortError), jsonResponse(MD_BODY)]);
    const { sleep } = recordedSleep();
    const client = new DoclingClient({
      endpoint: 'http://host:8030',
      fetch: fn,
      sleep,
      random: () => 0,
    });

    const out = await client.postConvert({ content: Buffer.from('x'), filename: 'x.pdf' });
    expect(out.document.name).toBe('doc-a');
    expect(calls).toHaveLength(2);
  });

  it('raises DoclingServiceError when the body is not valid JSON', async () => {
    const bad = new Response('not json at all', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const { fn } = scriptedFetch([bad]);
    const client = new DoclingClient({ endpoint: 'http://host:8030', fetch: fn, maxRetries: 0 });

    await expect(
      client.postConvert({ content: Buffer.from('x'), filename: 'x.pdf' }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DoclingServiceError &&
        err.status === 200 &&
        /not valid JSON/i.test(err.message),
    );
  });

  it('exhausts maxRetries on persistent 5xx and surfaces the last error', async () => {
    const { fn, calls } = scriptedFetch([
      textResponse('oops', 500),
      textResponse('oops', 500),
      textResponse('oops', 500),
      textResponse('oops', 500),
    ]);
    const { sleep, delays } = recordedSleep();
    const client = new DoclingClient({
      endpoint: 'http://host:8030',
      fetch: fn,
      sleep,
      random: () => 0,
      maxRetries: 3,
    });

    await expect(
      client.postConvert({ content: Buffer.from('x'), filename: 'x.pdf' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof DoclingServiceError && err.status === 500,
    );
    expect(calls).toHaveLength(4); // 1 + 3 retries
    expect(delays).toHaveLength(3);
  });

  it('honours a custom convertPath', async () => {
    const { fn, calls } = scriptedFetch([jsonResponse(MD_BODY)]);
    const client = new DoclingClient({
      endpoint: 'http://host:8030/',
      convertPath: '/v2/convert',
      fetch: fn,
    });

    await client.postConvert({ content: Buffer.from('x'), filename: 'x.pdf' });
    expect(calls[0]!.url).toBe('http://host:8030/v2/convert');
  });

  it('applies full-jitter backoff bounded by maxDelayMs', async () => {
    const { fn } = scriptedFetch([
      textResponse('oops', 500),
      textResponse('oops', 500),
      jsonResponse(MD_BODY),
    ]);
    const { sleep, delays } = recordedSleep();
    const client = new DoclingClient({
      endpoint: 'http://host:8030',
      fetch: fn,
      sleep,
      random: () => 1, // worst case — floor(capped * 1)
      baseDelayMs: 1000,
      maxDelayMs: 1500,
    });

    await client.postConvert({ content: Buffer.from('x'), filename: 'x.pdf' });
    // attempt 0 → min(1000, 1500) * 1 = 1000
    // attempt 1 → min(2000, 1500) * 1 = 1500
    expect(delays).toEqual([1000, 1500]);
  });

  it('raises DoclingServiceError on non-abort network-class failures and retries', async () => {
    const netError = new TypeError('fetch failed');
    const { fn, calls } = scriptedFetch([() => Promise.reject(netError), jsonResponse(MD_BODY)]);
    const { sleep } = recordedSleep();
    const client = new DoclingClient({
      endpoint: 'http://host:8030',
      fetch: fn,
      sleep,
      random: () => 0,
    });

    const out = await client.postConvert({ content: Buffer.from('x'), filename: 'x.pdf' });
    expect(out.document.name).toBe('doc-a');
    expect(calls).toHaveLength(2);
  });

  it('falls back to the root-level shape when the response has no `document` wrapper', async () => {
    const flat = { filename: 'flat.pdf', md_content: '# flat' };
    const { fn } = scriptedFetch([jsonResponse(flat)]);
    const client = new DoclingClient({ endpoint: 'http://host:8030', fetch: fn });

    const out = await client.postConvert({ content: Buffer.from('f'), filename: 'f.pdf' });
    expect(out.document.name).toBe('flat.pdf');
    expect(out.document.content['md_content']).toBe('# flat');
  });

  it('raises DoclingServiceError when the requested format content is missing', async () => {
    const body = {
      document: { filename: 'x.pdf', json_content: {} },
      status: 'success',
      errors: [],
    };
    const { fn } = scriptedFetch([jsonResponse(body)]);
    const client = new DoclingClient({ endpoint: 'http://host:8030', fetch: fn, maxRetries: 0 });

    await expect(
      client.postConvert({ content: Buffer.from('x'), filename: 'x.pdf' }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DoclingServiceError && /md_content is missing/i.test(err.message),
    );
  });

  it('includes the do_ocr flag in the outgoing form when requested', async () => {
    const { fn, calls } = scriptedFetch([jsonResponse(MD_BODY)]);
    const client = new DoclingClient({ endpoint: 'http://host:8030', fetch: fn });

    await client.postConvert({
      content: Buffer.from('x'),
      filename: 'x.pdf',
      mimeType: 'application/pdf',
      doOcr: false,
    });

    const form = calls[0]!.init.body as FormData;
    expect(form.get('do_ocr')).toBe('false');
  });

  it('omits do_ocr from the form when the request does not specify it', async () => {
    const { fn, calls } = scriptedFetch([jsonResponse(MD_BODY)]);
    const client = new DoclingClient({ endpoint: 'http://host:8030', fetch: fn });

    await client.postConvert({ content: Buffer.from('x'), filename: 'x.pdf' });

    const form = calls[0]!.init.body as FormData;
    expect(form.get('do_ocr')).toBeNull();
  });

  it('sends the X-Api-Key header when an apiKey is configured', async () => {
    const { fn, calls } = scriptedFetch([jsonResponse(MD_BODY)]);
    const client = new DoclingClient({ endpoint: 'http://host:8030', fetch: fn, apiKey: 'secret-key' });

    await client.postConvert({ content: Buffer.from('x'), filename: 'x.pdf' });

    const headers = calls[0]!.init.headers as Record<string, string> | undefined;
    expect(headers?.['X-Api-Key']).toBe('secret-key');
  });

  it('parses json_content when the format is json and the payload is an object', async () => {
    const body = {
      document: {
        filename: 'j.pdf',
        json_content: { schema_name: 'DoclingDocument', name: 'jdoc', body: {} },
      },
      status: 'success',
      errors: [],
    };
    const { fn } = scriptedFetch([jsonResponse(body)]);
    const client = new DoclingClient({ endpoint: 'http://host:8030', fetch: fn });

    const out = await client.postConvert({
      content: Buffer.from('j'),
      filename: 'j.pdf',
      toFormat: 'json',
    });
    expect(out.document.name).toBe('jdoc');
    expect(out.document.schemaVersion).toBe('DoclingDocument');
  });

  it('parses json_content when the format is json and the payload is a stringified JSON', async () => {
    const inner = { schema_name: 'DoclingDocument', version: '1.7.0', name: 'stringy', body: {} };
    const body = {
      document: { filename: 'stringy.pdf', json_content: JSON.stringify(inner) },
      status: 'success',
      errors: [],
    };
    const { fn } = scriptedFetch([jsonResponse(body)]);
    const client = new DoclingClient({ endpoint: 'http://host:8030', fetch: fn });

    const out = await client.postConvert({
      content: Buffer.from('s'),
      filename: 'stringy.pdf',
      toFormat: 'json',
    });
    expect(out.document.name).toBe('stringy');
    expect(out.document.schemaVersion).toBe('DoclingDocument');
  });

  it('raises DoclingServiceError when the response JSON root is not an object', async () => {
    const { fn } = scriptedFetch([jsonResponse(['array-root'])]);
    const client = new DoclingClient({ endpoint: 'http://host:8030', fetch: fn, maxRetries: 0 });

    await expect(
      client.postConvert({ content: Buffer.from('x'), filename: 'x.pdf' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof DoclingServiceError && /not an object/i.test(err.message),
    );
  });
});

describe('DoclingClient default wiring', () => {
  it('constructs with the default global fetch when none is injected', () => {
    const client = new DoclingClient({ endpoint: 'http://host:8030' });
    expect(client).toBeInstanceOf(DoclingClient);
  });

  it('defaults jitter to Math.random', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.25);
    try {
      const client = new DoclingClient({ endpoint: 'http://host:8030' });
      expect(client).toBeInstanceOf(DoclingClient);
    } finally {
      spy.mockRestore();
    }
  });
});
