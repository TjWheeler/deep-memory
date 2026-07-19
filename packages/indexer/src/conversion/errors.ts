/**
 * Typed errors raised by the document-conversion client.
 *
 * Both extend core's `ProviderError`: a conversion request talks to an
 * external HTTP service the pipeline depends on, which is exactly what
 * `ProviderError` already models. Extending it keeps the retry logic's
 * `instanceof` matching working on the subclasses and reuses the core
 * error contract (`message`, `suggestion`) without widening the closed
 * `DeepMemoryErrorCode` union.
 */

import { ProviderError } from '@utaba/deep-memory';

/**
 * Raised when the docling-serve HTTP service returns a non-2xx response, a
 * network-class failure, or an unparseable body. `status` is present on
 * HTTP-shape failures (the server responded) and absent on network-class
 * failures. `bodySnippet` carries up to ~1 KiB of the response body for
 * diagnostics.
 */
export class DoclingServiceError extends ProviderError {
  public readonly url: string;
  public readonly status: number | undefined;
  public readonly bodySnippet: string | undefined;

  constructor(
    url: string,
    detail: string,
    extra: { status?: number; bodySnippet?: string; suggestion?: string } = {},
  ) {
    super(
      `Docling service at "${url}" failed: ${detail}`,
      extra.suggestion ??
        `Check the docling-worker container logs and verify the endpoint is reachable.`,
    );
    this.name = 'DoclingServiceError';
    this.url = url;
    this.status = extra.status;
    this.bodySnippet = extra.bodySnippet;
  }
}

/** Raised when a request to docling-serve exceeds the configured timeout. */
export class DoclingTimeoutError extends DoclingServiceError {
  public readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(url, `no response within ${timeoutMs}ms`);
    this.name = 'DoclingTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}
