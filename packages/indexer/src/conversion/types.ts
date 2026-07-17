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
}

/** Response returned by `DoclingClient.postConvert`. */
export interface DoclingConvertResponse {
  /** The converted document. */
  document: DoclingDocument;
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
   * Optional API key sent as the `X-Api-Key` header. Present when
   * docling-serve is deployed behind authentication.
   */
  apiKey?: string;
  /**
   * Request timeout in milliseconds. Defaults to 120_000 (2 minutes).
   * Large PDFs routinely take ≥ 30s on CPU; shorter timeouts will retry or
   * fail spuriously.
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

/** Union of the structured errors the client raises. */
export type DoclingClientError = DoclingServiceError | DoclingTimeoutError;
