/**
 * DoclingClient — typed HTTP client for the docling-serve container.
 *
 * Surface: a single `postConvert` method that posts source bytes to
 * docling-serve's `/v1/convert/file` endpoint and returns the converted
 * document. Features:
 *
 *  - Content-hash caching. Identical (content, filename, mimeType, format)
 *    tuples return the previously-seen document without a round trip. LRU
 *    with a bounded cache size so long runs do not grow unboundedly.
 *  - Exponential-backoff retries with full jitter on transient failures
 *    (network errors, timeouts, 5xx, 429). 4xx responses are not retried —
 *    they are client-side contract failures.
 *  - Timeouts via AbortController. On abort the client raises
 *    DoclingTimeoutError; wall-clock delay is the configured timeoutMs plus
 *    whatever the abort handler takes to unwind.
 *  - Structured errors. Everything the caller needs to distinguish
 *    timeout-from-service-error-from-network is on the thrown class.
 *
 * All external dependencies (fetch, random, sleep) are injectable so the
 * client's tests do not need a real HTTP server or real wall-clock delays.
 */

import { createHash } from 'node:crypto';
import { DoclingServiceError, DoclingTimeoutError } from './errors.js';
import type {
  DoclingClientOptions,
  DoclingConvertRequest,
  DoclingConvertResponse,
  DoclingDocument,
  DoclingExportFormat,
} from './types.js';

const DEFAULT_CONVERT_PATH = '/v1/convert/file';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;
const DEFAULT_CACHE_MAX_ENTRIES = 32;
const DEFAULT_EXPORT_FORMAT: DoclingExportFormat = 'md';
const BODY_SNIPPET_LIMIT = 1024;

/** Envelope key carrying each export format's rendered content. */
const CONTENT_KEY_BY_FORMAT: Record<DoclingExportFormat, string> = {
  md: 'md_content',
  json: 'json_content',
  text: 'text_content',
  html: 'html_content',
};

export class DoclingClient {
  private readonly endpoint: string;
  private readonly convertPath: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly cacheMaxEntries: number;
  private readonly fetchFn: typeof fetch;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cache = new Map<string, DoclingDocument>();

  constructor(options: DoclingClientOptions) {
    this.endpoint = stripTrailingSlash(options.endpoint);
    this.convertPath = options.convertPath ?? DEFAULT_CONVERT_PATH;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.cacheMaxEntries = options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
    this.fetchFn = options.fetch ?? fetch;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Convert `request.content` via docling-serve and return the converted
   * document. Repeat calls with identical content + filename + mimeType +
   * format resolve from the in-memory cache without hitting the service.
   */
  public async postConvert(request: DoclingConvertRequest): Promise<DoclingConvertResponse> {
    const cacheKey = this.cacheKey(request);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      // Refresh recency by re-inserting.
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return { document: cached };
    }

    const document = await this.postWithRetries(request);
    this.cachePut(cacheKey, document);
    return { document };
  }

  private async postWithRetries(request: DoclingConvertRequest): Promise<DoclingDocument> {
    return this.requestWithRetries(() => this.postConvertOnce(request));
  }

  private async requestWithRetries<T>(call: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await call();
      } catch (err) {
        lastError = err;
        if (attempt === this.maxRetries || !isTransient(err)) {
          throw err;
        }
        await this.sleep(this.backoffMs(attempt));
      }
    }
    throw lastError ?? new DoclingServiceError(this.endpoint, 'request exhausted retries with no captured error');
  }

  private async postConvertOnce(request: DoclingConvertRequest): Promise<DoclingDocument> {
    const url = `${this.endpoint}${this.convertPath}`;
    const format = request.toFormat ?? DEFAULT_EXPORT_FORMAT;
    const form = this.buildConvertForm(request, format);
    const parsed = await this.sendForm(url, form);
    return toDoclingDocument(url, parsed.body, parsed.status, format);
  }

  private buildConvertForm(request: DoclingConvertRequest, format: DoclingExportFormat): FormData {
    const form = new FormData();
    const mime = request.mimeType ?? 'application/octet-stream';
    const blob = new Blob([new Uint8Array(request.content)], { type: mime });
    form.append('files', blob, request.filename);
    form.append('to_formats', format);
    if (request.doOcr !== undefined) {
      form.append('do_ocr', request.doOcr ? 'true' : 'false');
    }
    return form;
  }

  private async sendForm(
    url: string,
    form: FormData,
  ): Promise<{ body: unknown; status: number }> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {};
    if (this.apiKey !== undefined) {
      headers['X-Api-Key'] = this.apiKey;
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        body: form,
        signal: controller.signal,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new DoclingTimeoutError(url, this.timeoutMs);
      }
      throw new DoclingServiceError(url, `network error: ${errorMessage(err)}`);
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!response.ok) {
      const bodySnippet = await safeReadBodySnippet(response);
      throw new DoclingServiceError(
        url,
        `service returned HTTP ${response.status}`,
        { status: response.status, ...(bodySnippet !== undefined ? { bodySnippet } : {}) },
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (err) {
      throw new DoclingServiceError(
        url,
        `response body was not valid JSON: ${errorMessage(err)}`,
        { status: response.status },
      );
    }

    return { body: parsed, status: response.status };
  }

  private backoffMs(attempt: number): number {
    const exp = this.baseDelayMs * Math.pow(2, attempt);
    const capped = Math.min(exp, this.maxDelayMs);
    return Math.floor(capped * this.random());
  }

  private cacheKey(request: DoclingConvertRequest): string {
    const sha = createHash('sha256').update(request.content).digest('hex');
    const format = request.toFormat ?? DEFAULT_EXPORT_FORMAT;
    return `${sha}:${request.filename}:${request.mimeType ?? ''}:${format}`;
  }

  private cachePut(key: string, value: DoclingDocument): void {
    if (this.cache.size >= this.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, value);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return true;
  const code = (err as { code?: unknown }).code;
  return code === 'ABORT_ERR' || code === 20;
}

function isTransient(err: unknown): boolean {
  if (err instanceof DoclingTimeoutError) return true;
  if (err instanceof DoclingServiceError) {
    if (err.status === undefined) return true; // network-class / JSON parse
    if (err.status === 429) return true;
    if (err.status >= 500 && err.status < 600) return true;
    return false;
  }
  return false;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function safeReadBodySnippet(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    if (text.length <= BODY_SNIPPET_LIMIT) return text;
    return `${text.slice(0, BODY_SNIPPET_LIMIT)}…[truncated]`;
  } catch {
    return undefined;
  }
}

/**
 * Parse a docling-serve convert response into a DoclingDocument.
 *
 * docling-serve v1 returns an envelope:
 *   {document: {filename, md_content, json_content, html_content, ...},
 *    status, errors, processing_time, timings}
 * The rendered output for the requested `to_formats` lives under the matching
 * `*_content` field of `document`. `content` on the returned DoclingDocument
 * is that envelope's `document` object, so the caller can read whichever
 * rendered format it requested; `schemaVersion`/`name` are lifted from the
 * embedded `json_content` when present, else from the envelope filename.
 *
 * A flat-root fallback (treating the response root as the `document` object)
 * covers alternate deployments and test fixtures that speak the raw shape.
 */
export function toDoclingDocument(
  url: string,
  input: unknown,
  status: number,
  format: DoclingExportFormat,
): DoclingDocument {
  if (!isRecord(input)) {
    throw new DoclingServiceError(url, 'response JSON root is not an object', { status });
  }

  const envelope = input['document'];
  const doc = isRecord(envelope) ? envelope : input;

  const contentKey = CONTENT_KEY_BY_FORMAT[format];
  const rendered = doc[contentKey];
  if (rendered === null || rendered === undefined) {
    throw new DoclingServiceError(
      url,
      `${contentKey} is missing; the service may not be returning the requested format`,
      { status },
    );
  }

  // Validate the requested format is usable: JSON must resolve to an object;
  // the text-shaped formats must be non-empty strings.
  if (format === 'json') {
    const payload = resolveJsonContent(url, status, rendered);
    if (payload === undefined) {
      throw new DoclingServiceError(
        url,
        `${contentKey} is not a usable JSON document`,
        { status },
      );
    }
  } else if (typeof rendered !== 'string') {
    throw new DoclingServiceError(
      url,
      `${contentKey} is not a string`,
      { status },
    );
  }

  const embedded = resolveJsonContent(url, status, doc['json_content']);
  const schemaVersion =
    (embedded && pickSchemaVersion(embedded)) ?? 'unknown';
  const name =
    (embedded && pickString(embedded, 'name')) ??
    pickString(doc, 'filename') ??
    'unnamed';

  return { schemaVersion, name, content: doc };
}

/**
 * Resolve a docling `*_content` value that may be either an embedded object
 * or a stringified JSON payload. Returns undefined when the value is absent
 * or not object-shaped; throws only when a present string fails to parse.
 */
function resolveJsonContent(
  url: string,
  status: number,
  value: unknown,
): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : undefined;
    } catch (err) {
      throw new DoclingServiceError(
        url,
        `json_content is not valid JSON: ${errorMessage(err)}`,
        { status },
      );
    }
  }
  return undefined;
}

function pickSchemaVersion(obj: Record<string, unknown>): string | undefined {
  return (
    pickString(obj, 'schema_name') ??
    pickString(obj, 'schemaVersion') ??
    pickString(obj, 'version')
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pickString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
