/**
 * Types for the document-conversion HTTP client.
 *
 * The client talks to a `docling-serve` container running under the
 * `docling-worker` docker-compose profile. Its surface is the
 * `/v1/convert/file` endpoint — a multipart POST that returns a converted
 * document. The interior of `DoclingDocument.content` is deliberately opaque:
 * the format gateway serialises the requested export format to disk without
 * interpreting the structure. Tightening the interior shape here would couple
 * the client to a specific docling-serve schema version.
 */

import type { DoclingServiceError, DoclingTimeoutError } from './errors.js';

/**
 * A converted document returned by a docling-serve convert call.
 *
 * `content` is the full `document` payload from docling-serve as received —
 * unopened. The client only surfaces the top-level name + schema version for
 * logging and diagnostic use.
 */
export interface DoclingDocument {
  /** Schema identifier reported by docling-serve (e.g. `DoclingDocument`). */
  schemaVersion: string;
  /** Document name — typically derived from the uploaded filename. */
  name: string;
  /** Full document payload returned by docling-serve, kept opaque. */
  content: Record<string, unknown>;
}

/** Export format requested from docling-serve for a single conversion. */
export type DoclingExportFormat = 'md' | 'json' | 'text' | 'html';

/**
 * Conversion tuning passed through to docling-serve's convert/prepare step.
 * Every field is optional; an unset field is not sent, so docling's own
 * default applies. These control how a document is turned into text — most
 * notably `tableCellMatching`, which when disabled stops docling matching its
 * table predictions back to raw PDF cells, the behaviour that fragments
 * merged/dense columns.
 */
export interface DoclingConvertOptions {
  /**
   * Match predicted table structure back to raw PDF text cells. docling's
   * default is on, which is best for well-separated tables but corrupts
   * merged/dense columns; disable it for a document whose tables fragment.
   */
  tableCellMatching?: boolean;
  /**
   * Table-structure model mode. `accurate` is docling's default and the
   * higher-fidelity choice; `fast` trades quality for speed.
   */
  tableMode?: 'fast' | 'accurate';
  /** Run table-structure recovery at all. */
  doTableStructure?: boolean;
  /** PDF parsing backend docling uses for the conversion. */
  pdfBackend?: string;
}

/** Arguments accepted by `DoclingClient.postConvert`. */
export interface DoclingConvertRequest {
  /** Source bytes. */
  content: Buffer;
  /** Source filename — used by docling-serve for format detection + metadata. */
  filename: string;
  /**
   * Optional MIME type hint. Defaults to `application/octet-stream` when
   * absent; docling-serve sniffs the filename extension regardless, so this
   * is typically only needed when the filename cannot carry an extension.
   */
  mimeType?: string;
  /**
   * Export format the service should populate on the response. Defaults to
   * `md`. Chooses which `*_content` field the envelope parser reads.
   */
  toFormat?: DoclingExportFormat;
  /**
   * Whether docling-serve runs OCR on the source. OCR is expensive and is
   * the usual cause of multi-minute conversions on born-digital PDFs, so it
   * is an explicit per-request decision. When omitted, the service default
   * applies.
   */
  doOcr?: boolean;
  /**
   * Conversion tuning forwarded to docling-serve's convert step. Each field is
   * sent only when set; an absent option leaves docling's default in force, so
   * an unset `convertOptions` reproduces the prior form byte-for-byte.
   */
  convertOptions?: DoclingConvertOptions;
}

/** Response returned by `DoclingClient.postConvert`. */
export interface DoclingConvertResponse {
  /** The converted document. */
  document: DoclingDocument;
}

/**
 * A conversion task descriptor returned by the asynchronous convert endpoints.
 *
 * docling-serve accepts a long-running conversion via `/v1/convert/file/async`
 * (returning this descriptor immediately), then reports progress via
 * `/v1/status/poll/{id}` and yields the finished document via
 * `/v1/result/{id}`. `taskStatus` walks `pending → started → success` on the
 * happy path, or terminates at `failure`. `taskPosition` is the descriptor's
 * queue position when the service reports one; it is advisory and may be
 * absent.
 */
export interface DoclingAsyncTask {
  /** Server-assigned identifier used to poll status and fetch the result. */
  taskId: string;
  /** Lifecycle state of the conversion job. */
  taskStatus: 'pending' | 'started' | 'success' | 'failure';
  /** Advisory queue position reported by the service, when present. */
  taskPosition?: number;
}

/** Construction options for the conversion HTTP client. */
export interface DoclingClientOptions {
  /**
   * Base URL of the docling-serve container — scheme + host + port only, no
   * trailing slash (e.g. `http://localhost:5001`).
   */
  endpoint: string;
  /**
   * HTTP path appended to `endpoint` when calling the convert endpoint.
   * Defaults to `/v1/convert/file` which matches the current docling-serve
   * image. Overridable for future docling-serve API versions or routing.
   */
  convertPath?: string;
  /**
   * HTTP path appended to `endpoint` for submitting an asynchronous
   * conversion. Defaults to `/v1/convert/file/async`. The submit body is
   * identical to the synchronous convert form.
   */
  asyncSubmitPath?: string;
  /**
   * HTTP path prefix appended to `endpoint` for polling task status. The task
   * id is appended as a trailing path segment. Defaults to `/v1/status/poll`.
   */
  statusPollPath?: string;
  /**
   * HTTP path prefix appended to `endpoint` for fetching a finished task's
   * result. The task id is appended as a trailing path segment. Defaults to
   * `/v1/result`.
   */
  resultPath?: string;
  /**
   * Optional API key sent as the `X-Api-Key` header. Present when
   * docling-serve is deployed behind authentication.
   */
  apiKey?: string;
  /**
   * Per-request timeout in milliseconds. Defaults to 600_000 (10 minutes).
   * CPU-only layout/table inference on a large, table-heavy PDF routinely
   * runs several minutes; a shorter ceiling turns a slow-but-fine conversion
   * into a spurious timeout/retry loop. On the async path this bounds each
   * individual HTTP call (submit / poll / result), not the whole job.
   */
  timeoutMs?: number;
  /**
   * Maximum number of retry attempts after the initial call on transient
   * failures (timeout, network error, 5xx, 429). Defaults to 3 — total call
   * budget is 1 + maxRetries.
   */
  maxRetries?: number;
  /**
   * Base delay in milliseconds for exponential backoff. Attempt N waits
   * `random() * min(maxDelayMs, baseDelayMs * 2^N)` (full-jitter).
   * Defaults to 500ms.
   */
  baseDelayMs?: number;
  /** Cap on per-retry backoff delay in milliseconds. Defaults to 8_000. */
  maxDelayMs?: number;
  /**
   * Base delay in milliseconds for the wait between status polls on the async
   * path. Each wait is `random() * min(maxPollIntervalMs, pollIntervalMs *
   * 2^N)` (full-jitter), so early polls are quick and long jobs back off.
   * Defaults to 1_000ms.
   */
  pollIntervalMs?: number;
  /**
   * Cap on the async poll interval in milliseconds — the ceiling the jittered
   * backoff between polls grows toward. Defaults to 15_000ms.
   */
  maxPollIntervalMs?: number;
  /**
   * Safety ceiling in milliseconds on the whole async job — from submit until
   * a terminal status. Async deliberately has no single-request wall clock, so
   * this exists only to stop an indefinitely-`pending` task from polling
   * forever. Defaults to 3_600_000 (1 hour), i.e. generous enough to be
   * effectively off for any real conversion; lower it only to fail fast on a
   * wedged container.
   */
  maxTotalWaitMs?: number;
  /**
   * Maximum entries in the content-hash cache. Cache is keyed by
   * sha256(content)+filename+mimeType+format; identical bytes reuse the last
   * response. Defaults to 32 — keeps memory bounded on long runs.
   */
  cacheMaxEntries?: number;
  /**
   * Injected fetch implementation. Defaults to the global `fetch`. Tests
   * inject a mock here instead of binding against a real HTTP server.
   */
  fetch?: typeof fetch;
  /**
   * Injected PRNG for jitter — tests pass `() => 0` for deterministic
   * delays. Defaults to `Math.random`.
   */
  random?: () => number;
  /**
   * Injected sleep for backoff. Defaults to `setTimeout`. Tests pass a
   * synchronous resolver so retry suites don't wait real milliseconds.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Decision returned by an async `onPoll` callback. `'continue'` keeps polling;
 * `'stop'` breaks the poll loop before the next status check — the caller's
 * escape hatch for an external stop signal. `void`/`undefined` is treated as
 * `'continue'` so a callback that only reports progress need not return.
 */
export type PollDecision = 'continue' | 'stop';

/** Per-call options for `DoclingClient.convertViaAsync`. */
export interface ConvertViaAsyncOptions {
  /**
   * Invoked once per poll cycle with the latest task descriptor. The caller
   * uses it to report progress and to abort: returning `'stop'` breaks the
   * loop before the next status check without fetching a result. Returning
   * `'continue'` (or nothing) keeps polling.
   */
  onPoll?: (task: DoclingAsyncTask) => PollDecision | void | Promise<PollDecision | void>;
  /** Override the poll backoff base interval for this call. */
  pollIntervalMs?: number;
  /** Override the poll backoff ceiling for this call. */
  maxPollIntervalMs?: number;
  /** Override the whole-job safety ceiling for this call. */
  maxTotalWaitMs?: number;
}

/** Union of the structured errors the client raises. */
export type DoclingClientError = DoclingServiceError | DoclingTimeoutError;
