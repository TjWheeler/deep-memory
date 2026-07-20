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
  ConvertViaAsyncOptions,
  DoclingAsyncTask,
  DoclingClientOptions,
  DoclingConvertOptions,
  DoclingConvertRequest,
  DoclingConvertResponse,
  DoclingDocument,
  DoclingExportFormat,
} from './types.js';

const DEFAULT_CONVERT_PATH = '/v1/convert/file';
const DEFAULT_ASYNC_SUBMIT_PATH = '/v1/convert/file/async';
const DEFAULT_STATUS_POLL_PATH = '/v1/status/poll';
const DEFAULT_RESULT_PATH = '/v1/result';
// Per-request wall clock for a synchronous convert. CPU-only layout/table
// inference on a large, table-heavy PDF routinely runs several minutes, so the
// default is deliberately generous — a tighter ceiling turns a slow-but-fine
// conversion into a timeout/retry loop that never lands. Override via
// services.docling.timeoutMs for pathological outliers.
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;
const DEFAULT_CACHE_MAX_ENTRIES = 32;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_POLL_INTERVAL_MS = 15_000;
// A generous whole-job ceiling: async has no per-request wall clock by design,
// so this exists only to stop an indefinitely-pending task from polling
// forever, not to bound a legitimately slow conversion.
const DEFAULT_MAX_TOTAL_WAIT_MS = 3_600_000;
const DEFAULT_EXPORT_FORMAT: DoclingExportFormat = 'md';
const BODY_SNIPPET_LIMIT = 1024;

// Suggestion attached to an async-submit 404 so the failure is self-explaining:
// the container predates or was misconfigured without the async routes.
const ASYNC_UNSUPPORTED_SUGGESTION =
  "The docling-worker container did not expose the async convert route. Set services.docling.mode to 'sync' or update the docling-worker container to a build that supports asynchronous conversion.";

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
  private readonly asyncSubmitPath: string;
  private readonly statusPollPath: string;
  private readonly resultPath: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxPollIntervalMs: number;
  private readonly maxTotalWaitMs: number;
  private readonly cacheMaxEntries: number;
  private readonly fetchFn: typeof fetch;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cache = new Map<string, DoclingDocument>();

  constructor(options: DoclingClientOptions) {
    this.endpoint = stripTrailingSlash(options.endpoint);
    this.convertPath = options.convertPath ?? DEFAULT_CONVERT_PATH;
    this.asyncSubmitPath = options.asyncSubmitPath ?? DEFAULT_ASYNC_SUBMIT_PATH;
    this.statusPollPath = stripTrailingSlash(options.statusPollPath ?? DEFAULT_STATUS_POLL_PATH);
    this.resultPath = stripTrailingSlash(options.resultPath ?? DEFAULT_RESULT_PATH);
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPollIntervalMs = options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS;
    this.maxTotalWaitMs = options.maxTotalWaitMs ?? DEFAULT_MAX_TOTAL_WAIT_MS;
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
    const cached = this.cacheGet(cacheKey);
    if (cached !== undefined) {
      return { document: cached };
    }

    const document = await this.postWithRetries(request);
    this.cachePut(cacheKey, document);
    return { document };
  }

  /**
   * Submit `request` for asynchronous conversion and return the task
   * descriptor. The submit body is byte-identical to the synchronous convert
   * form, so it is built with the same `buildConvertForm`. Transient failures
   * are retried like the sync path; a 404 (a container without the async
   * route) is surfaced with a suggestion naming the sync escape hatch rather
   * than the generic connectivity hint.
   */
  public async postConvertAsync(request: DoclingConvertRequest): Promise<DoclingAsyncTask> {
    const url = `${this.endpoint}${this.asyncSubmitPath}`;
    const format = request.toFormat ?? DEFAULT_EXPORT_FORMAT;
    return this.requestWithRetries(async () => {
      const form = this.buildConvertForm(request, format);
      const parsed = await this.sendForm(url, form, ASYNC_UNSUPPORTED_SUGGESTION);
      return toDoclingAsyncTask(url, parsed.body, parsed.status);
    });
  }

  /**
   * Poll the status of a submitted task. Transient failures are retried; the
   * returned descriptor carries the current `taskStatus` and, when reported,
   * the queue position.
   */
  public async pollTaskStatus(taskId: string): Promise<DoclingAsyncTask> {
    const url = `${this.endpoint}${this.statusPollPath}/${encodeURIComponent(taskId)}`;
    return this.requestWithRetries(async () => {
      const parsed = await this.sendGet(url);
      return toDoclingAsyncTask(url, parsed.body, parsed.status);
    });
  }

  /**
   * Fetch the finished result of a task and parse it with the same envelope
   * reader the synchronous endpoint uses — the async result body is the same
   * shape. This must be called only after a `success` poll: the poll loop is
   * the readiness guard, so a non-200 here is a caller bug (a result requested
   * before the task finished) and surfaces as a `DoclingServiceError` rather
   * than being retried. Callers must fetch promptly — docling-serve evicts a
   * completed result after a TTL.
   */
  public async fetchTaskResult(
    taskId: string,
    format: DoclingExportFormat,
  ): Promise<DoclingConvertResponse> {
    const url = `${this.endpoint}${this.resultPath}/${encodeURIComponent(taskId)}`;
    const parsed = await this.sendGet(url);
    const document = toDoclingDocument(url, parsed.body, parsed.status, format);
    return { document };
  }

  /**
   * Convert `request` via the asynchronous submit/poll/fetch protocol and
   * return the finished document. Submits, then polls with full-jitter backoff
   * bounded by the poll-interval settings, invoking `opts.onPoll` once per
   * cycle so the caller can report progress and abort. Resolves on `success`
   * by fetching the result; throws `DoclingServiceError` on `failure`.
   *
   * There is no single-request wall clock over the whole job — each individual
   * HTTP call keeps its own `timeoutMs` abort. The loop terminates on (a) an
   * `onPoll` callback returning `'stop'`, (b) the `maxTotalWaitMs` safety
   * ceiling, or (c) a terminal task status. The resolved document is cached on
   * the same key `postConvert` uses, so a subsequent identical convert — sync
   * or async — is a cache hit.
   */
  public async convertViaAsync(
    request: DoclingConvertRequest,
    opts: ConvertViaAsyncOptions = {},
  ): Promise<DoclingConvertResponse> {
    const cacheKey = this.cacheKey(request);
    const cached = this.cacheGet(cacheKey);
    if (cached !== undefined) {
      return { document: cached };
    }

    const format = request.toFormat ?? DEFAULT_EXPORT_FORMAT;
    const pollIntervalMs = opts.pollIntervalMs ?? this.pollIntervalMs;
    const maxPollIntervalMs = opts.maxPollIntervalMs ?? this.maxPollIntervalMs;
    const maxTotalWaitMs = opts.maxTotalWaitMs ?? this.maxTotalWaitMs;

    const submitted = await this.postConvertAsync(request);

    // Elapsed is accumulated from the polls' own waits rather than a wall
    // clock, so the safety ceiling is deterministic under an injected sleep
    // and correct under a real one.
    let elapsedMs = 0;
    let task = submitted;
    for (let attempt = 0; ; attempt++) {
      const decision = await opts.onPoll?.(task);
      if (decision === 'stop') {
        throw new DoclingServiceError(
          `${this.endpoint}${this.statusPollPath}/${task.taskId}`,
          'conversion stopped before completion',
        );
      }

      if (task.taskStatus === 'success') {
        const result = await this.fetchTaskResult(task.taskId, format);
        this.cachePut(cacheKey, result.document);
        return result;
      }
      if (task.taskStatus === 'failure') {
        throw new DoclingServiceError(
          `${this.endpoint}${this.statusPollPath}/${task.taskId}`,
          'conversion task reported failure',
        );
      }

      if (elapsedMs >= maxTotalWaitMs) {
        throw new DoclingServiceError(
          `${this.endpoint}${this.statusPollPath}/${task.taskId}`,
          `conversion did not finish within ${maxTotalWaitMs}ms`,
        );
      }

      const wait = this.pollBackoffMs(attempt, pollIntervalMs, maxPollIntervalMs);
      await this.sleep(wait);
      elapsedMs += wait;

      task = await this.pollTaskStatus(task.taskId);
    }
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
    const convertOptions = request.convertOptions;
    if (convertOptions !== undefined) {
      // Each option is appended only when set, so an unset field leaves
      // docling's default in force and the form matches the pre-options shape.
      if (convertOptions.tableCellMatching !== undefined) {
        form.append('table_cell_matching', convertOptions.tableCellMatching ? 'true' : 'false');
      }
      if (convertOptions.tableMode !== undefined) {
        form.append('table_mode', convertOptions.tableMode);
      }
      if (convertOptions.doTableStructure !== undefined) {
        form.append('do_table_structure', convertOptions.doTableStructure ? 'true' : 'false');
      }
      if (convertOptions.pdfBackend !== undefined) {
        form.append('pdf_backend', convertOptions.pdfBackend);
      }
    }
    return form;
  }

  /**
   * POST a multipart form and return the parsed JSON body + status. When
   * `notFoundSuggestion` is supplied, a 404 carries it as the error suggestion
   * — used by the async submit to point a caller at the sync escape hatch when
   * a container lacks the async route.
   */
  private async sendForm(
    url: string,
    form: FormData,
    notFoundSuggestion?: string,
  ): Promise<{ body: unknown; status: number }> {
    return this.sendRequest(url, { method: 'POST', body: form }, notFoundSuggestion);
  }

  /** GET a URL and return the parsed JSON body + status. */
  private async sendGet(url: string): Promise<{ body: unknown; status: number }> {
    return this.sendRequest(url, { method: 'GET' });
  }

  private async sendRequest(
    url: string,
    init: { method: string; body?: FormData },
    notFoundSuggestion?: string,
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
        method: init.method,
        ...(init.body !== undefined ? { body: init.body } : {}),
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
        {
          status: response.status,
          ...(bodySnippet !== undefined ? { bodySnippet } : {}),
          ...(response.status === 404 && notFoundSuggestion !== undefined
            ? { suggestion: notFoundSuggestion }
            : {}),
        },
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
    return fullJitter(this.baseDelayMs, this.maxDelayMs, attempt, this.random());
  }

  private pollBackoffMs(attempt: number, base: number, cap: number): number {
    return fullJitter(base, cap, attempt, this.random());
  }

  private cacheKey(request: DoclingConvertRequest): string {
    const sha = createHash('sha256').update(request.content).digest('hex');
    const format = request.toFormat ?? DEFAULT_EXPORT_FORMAT;
    // The OCR flag is part of the key: an OCR fallback reconverts the same
    // bytes/filename/mime/format with doOcr flipped, and must not resolve the
    // earlier no-OCR document from the cache.
    const ocr = request.doOcr === undefined ? 'default' : String(request.doOcr);
    // Convert options are part of the key: a re-convert that only changes a
    // convert option (e.g. flipping tableCellMatching) reconverts the same
    // bytes/filename/mime/format and must not resolve the earlier document.
    const convertOptions = serializeConvertOptions(request.convertOptions);
    return `${sha}:${request.filename}:${request.mimeType ?? ''}:${format}:${ocr}:${convertOptions}`;
  }

  private cacheGet(key: string): DoclingDocument | undefined {
    const cached = this.cache.get(key);
    if (cached === undefined) return undefined;
    // Refresh recency by re-inserting.
    this.cache.delete(key);
    this.cache.set(key, cached);
    return cached;
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

/**
 * Serialise convert options into a stable, order-independent cache-key fragment.
 * Fields are emitted in a fixed key order and only when set, so two option sets
 * with the same values collide and any difference (including set-vs-unset)
 * produces a distinct fragment.
 */
function serializeConvertOptions(options: DoclingConvertOptions | undefined): string {
  if (options === undefined) return 'default';
  // Emit fixed-order [key, value] pairs and JSON.stringify the whole array, so a
  // free-form value (pdfBackend) containing a delimiter cannot forge a fragment
  // boundary and collide with a different option set.
  const pairs: Array<[string, string | boolean]> = [];
  if (options.doTableStructure !== undefined) pairs.push(['doTableStructure', options.doTableStructure]);
  if (options.pdfBackend !== undefined) pairs.push(['pdfBackend', options.pdfBackend]);
  if (options.tableCellMatching !== undefined) pairs.push(['tableCellMatching', options.tableCellMatching]);
  if (options.tableMode !== undefined) pairs.push(['tableMode', options.tableMode]);
  return pairs.length > 0 ? JSON.stringify(pairs) : 'default';
}

/** Full-jitter exponential backoff: `random * min(cap, base * 2^attempt)`. */
function fullJitter(base: number, cap: number, attempt: number, random: number): number {
  const exp = base * Math.pow(2, attempt);
  const capped = Math.min(exp, cap);
  return Math.floor(capped * random);
}

/**
 * Parse a docling-serve async task descriptor into a DoclingAsyncTask.
 *
 * The submit and status endpoints return `{task_id, task_status,
 * task_position, task_meta}`. Read defensively like `toDoclingDocument`:
 * tolerate a missing `task_position` (advisory), coerce a numeric-string
 * position, and never throw on an absent optional key. A missing or non-string
 * `task_id`, or a `task_status` outside the known lifecycle, is a genuine
 * contract failure and raises `DoclingServiceError`.
 */
export function toDoclingAsyncTask(url: string, input: unknown, status: number): DoclingAsyncTask {
  if (!isRecord(input)) {
    throw new DoclingServiceError(url, 'task descriptor JSON root is not an object', { status });
  }

  const taskId = pickString(input, 'task_id');
  if (taskId === undefined) {
    throw new DoclingServiceError(url, 'task descriptor is missing task_id', { status });
  }

  const rawStatus = pickString(input, 'task_status');
  if (rawStatus === undefined || !isTaskStatus(rawStatus)) {
    throw new DoclingServiceError(
      url,
      `task descriptor has an unexpected task_status: ${String(rawStatus)}`,
      { status },
    );
  }

  const position = pickFiniteNumber(input, 'task_position');
  return {
    taskId,
    taskStatus: rawStatus,
    ...(position !== undefined ? { taskPosition: position } : {}),
  };
}

function isTaskStatus(v: string): v is DoclingAsyncTask['taskStatus'] {
  return v === 'pending' || v === 'started' || v === 'success' || v === 'failure';
}

function pickFiniteNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
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
