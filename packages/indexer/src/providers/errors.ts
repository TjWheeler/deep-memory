/**
 * Typed errors raised by the built-in OpenAI-compatible chat provider.
 *
 * Extends core's `ProviderError`: the provider talks to an external HTTP
 * completions endpoint the pipeline depends on, which is exactly what
 * `ProviderError` already models. Extending it keeps the extraction retry
 * logic's `instanceof` matching working on the subclass and reuses the core
 * error contract (`message`, `suggestion`) without widening the closed
 * `DeepMemoryErrorCode` union.
 */

import { ProviderError } from '@utaba/deep-memory';

/**
 * Raised when the transport to an OpenAI-compatible endpoint fails: an
 * idle/connection timeout, a dropped socket, or a stream that ended without a
 * terminal frame.
 *
 * A completions request over `fetch` surfaces these as a bare
 * `TypeError: fetch failed` whose real cause hides in `error.cause.code`
 * (e.g. `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`, `UND_ERR_SOCKET`,
 * `ECONNRESET`). That undecorated error is expensive to diagnose because the
 * message names neither the endpoint nor the timeout class. This error carries
 * both — the endpoint `url` and the decoded `causeCode` when present — and a
 * suggestion that explains the idle-timeout class in plain terms.
 */
export class LLMTransportError extends ProviderError {
  public readonly url: string;
  public readonly causeCode: string | undefined;
  public readonly status: number | undefined;

  constructor(
    url: string,
    detail: string,
    extra: { causeCode?: string; status?: number; suggestion?: string } = {},
  ) {
    super(
      `LLM transport to "${url}" failed: ${detail}` +
        (extra.causeCode ? ` (cause: ${extra.causeCode})` : '') +
        (extra.status !== undefined ? ` (HTTP ${extra.status})` : ''),
      extra.suggestion ??
        `The request stalled or the connection dropped before the completion finished. ` +
          `A non-streaming completion sends no bytes until generation is done, so a long ` +
          `generation can outrun the client's idle timeout and surface as a bare "fetch failed". ` +
          `Prefer streaming (the default) so response headers arrive immediately and the idle ` +
          `timer resets on every token; if a proxy buffers SSE, fix the proxy rather than the client.`,
    );
    this.name = 'LLMTransportError';
    this.url = url;
    this.causeCode = extra.causeCode;
    this.status = extra.status;
  }
}
