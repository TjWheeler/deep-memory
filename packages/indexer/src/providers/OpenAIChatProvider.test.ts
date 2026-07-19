import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InvalidInputError } from '@utaba/deep-memory';
import { OpenAIChatProvider } from './OpenAIChatProvider.js';
import { LLMTransportError } from './errors.js';

const ENDPOINT = 'http://localhost:9999/v1';
const REQUEST_OPTIONS = { model: 'test-model', temperature: 0, maxTokens: 1024 };

/**
 * Build a Response whose body is a ReadableStream emitting the supplied byte
 * chunks in order. The caller controls the chunk boundaries so a single SSE
 * frame can be split across two network reads.
 */
function streamingResponse(chunks: string[], init?: { status?: number }): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]!));
        index += 1;
      } else {
        controller.close();
      }
    },
  });
  return new Response(body, {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** A frame carrying a content delta. */
function contentFrame(content: string, finishReason?: string): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { content }, finish_reason: finishReason ?? null }],
  })}\n\n`;
}

/** The terminal include_usage frame: empty choices, usage populated. */
function usageFrame(promptTokens: number, completionTokens: number): string {
  return `data: ${JSON.stringify({
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  })}\n\n`;
}

const DONE = 'data: [DONE]\n\n';

function createProvider(stream?: boolean): OpenAIChatProvider {
  return new OpenAIChatProvider({ endpoint: ENDPOINT, stream });
}

describe('OpenAIChatProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('streaming content assembly', () => {
    it('assembles delta.content across frames and captures usage and finish_reason', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        streamingResponse([
          contentFrame('{"entities": '),
          contentFrame('[]}'),
          contentFrame('', 'stop'),
          usageFrame(120, 45),
          DONE,
        ]),
      );
      vi.stubGlobal('fetch', fetchMock);

      const provider = createProvider();
      const result = await provider.chatCompletion('sys', 'user', REQUEST_OPTIONS);

      expect(result.content).toBe('{"entities": []}');
      expect(result.finish_reason).toBe('stop');
      expect(result.usage).toEqual({ prompt_tokens: 120, completion_tokens: 45 });

      // The wire request must actually be streaming.
      const [, requestInit] = fetchMock.mock.calls[0]!;
      const sentBody = JSON.parse((requestInit as RequestInit).body as string);
      expect(sentBody.stream).toBe(true);
      expect(sentBody.stream_options).toEqual({ include_usage: true });
    });

    it('captures usage from a usage-only frame whose choices array is empty', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          streamingResponse([
            contentFrame('hello', 'stop'),
            usageFrame(10, 3),
            DONE,
          ]),
        ),
      );

      const result = await createProvider().chatCompletion('sys', 'user', REQUEST_OPTIONS);

      expect(result.content).toBe('hello');
      expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 3 });
    });

    it('returns undefined usage when no usage frame is sent', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          streamingResponse([contentFrame('data', 'stop'), DONE]),
        ),
      );

      const result = await createProvider().chatCompletion('sys', 'user', REQUEST_OPTIONS);

      expect(result.content).toBe('data');
      expect(result.usage).toBeUndefined();
    });

    it('ignores SSE comment / keep-alive lines', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          streamingResponse([
            ': keep-alive ping\n\n',
            contentFrame('payload', 'stop'),
            ': another comment\n',
            DONE,
          ]),
        ),
      );

      const result = await createProvider().chatCompletion('sys', 'user', REQUEST_OPTIONS);

      expect(result.content).toBe('payload');
    });

    it('reassembles a single frame split across two network chunks', async () => {
      const whole = contentFrame('split-content', 'stop');
      const cut = Math.floor(whole.length / 2);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          streamingResponse([whole.slice(0, cut), whole.slice(cut), DONE]),
        ),
      );

      const result = await createProvider().chatCompletion('sys', 'user', REQUEST_OPTIONS);

      expect(result.content).toBe('split-content');
    });

    it('ignores reasoning_content deltas and accumulates only content', async () => {
      const reasoningFrame = `data: ${JSON.stringify({
        choices: [{ delta: { reasoning_content: 'thinking out loud' }, finish_reason: null }],
      })}\n\n`;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          streamingResponse([
            reasoningFrame,
            contentFrame('visible', 'stop'),
            DONE,
          ]),
        ),
      );

      const result = await createProvider().chatCompletion('sys', 'user', REQUEST_OPTIONS);

      expect(result.content).toBe('visible');
    });

    it('reports finish_reason "length" so the worker salvage path can key off it', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          streamingResponse([
            contentFrame('{"entities": [', 'length'),
            usageFrame(50, 1024),
            DONE,
          ]),
        ),
      );

      const result = await createProvider().chatCompletion('sys', 'user', REQUEST_OPTIONS);

      expect(result.finish_reason).toBe('length');
      expect(result.content).toBe('{"entities": [');
    });

    it('parses terminal frames that arrive without a trailing newline', async () => {
      // The final usage frame and [DONE] end the stream with no trailing "\n",
      // so they survive only via the post-loop residual-buffer flush.
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          streamingResponse([
            contentFrame('assembled', 'stop'),
            `data: ${JSON.stringify({
              choices: [],
              usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
            })}\n\ndata: [DONE]`,
          ]),
        ),
      );

      const result = await createProvider().chatCompletion('sys', 'user', REQUEST_OPTIONS);

      expect(result.content).toBe('assembled');
      expect(result.finish_reason).toBe('stop');
      expect(result.usage).toEqual({ prompt_tokens: 8, completion_tokens: 4 });
    });
  });

  describe('streaming failure handling', () => {
    it('throws a transport error when the stream ends without [DONE] or a terminal finish_reason', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          // Content arrives, then the stream simply closes — no [DONE], no
          // finish_reason. This must not be reported as partial success.
          streamingResponse([contentFrame('{"entities": [')]),
        ),
      );

      await expect(
        createProvider().chatCompletion('sys', 'user', REQUEST_OPTIONS),
      ).rejects.toBeInstanceOf(LLMTransportError);
    });

    it('throws a transport error on a mid-stream error frame', async () => {
      const errorFrame = `data: ${JSON.stringify({
        error: { message: 'model overloaded', code: 'server_error' },
      })}\n\n`;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          streamingResponse([contentFrame('partial'), errorFrame]),
        ),
      );

      await expect(
        createProvider().chatCompletion('sys', 'user', REQUEST_OPTIONS),
      ).rejects.toThrow(/model overloaded/);
    });

    it('decodes an undici cause code from a rejected fetch into a transport error', async () => {
      const failure = new TypeError('fetch failed');
      (failure as { cause?: unknown }).cause = { code: 'UND_ERR_HEADERS_TIMEOUT' };
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure));

      const promise = createProvider().chatCompletion('sys', 'user', REQUEST_OPTIONS);
      await expect(promise).rejects.toBeInstanceOf(LLMTransportError);
      await promise.catch((err: LLMTransportError) => {
        expect(err.causeCode).toBe('UND_ERR_HEADERS_TIMEOUT');
      });
    });
  });

  describe('abort semantics', () => {
    it('propagates an abort during the stream as cancellation, not a transport error', async () => {
      const controller = new AbortController();
      const encoder = new TextEncoder();
      let firstRead = true;
      const body = new ReadableStream<Uint8Array>({
        pull(streamController) {
          if (firstRead) {
            firstRead = false;
            streamController.enqueue(encoder.encode(contentFrame('partial')));
            return;
          }
          // Simulate the fetch body rejecting because the request was aborted.
          controller.abort();
          streamController.error(
            Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
          );
        },
      });
      const response = new Response(body, { status: 200 });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

      const promise = createProvider().chatCompletion(
        'sys',
        'user',
        REQUEST_OPTIONS,
        controller.signal,
      );

      await expect(promise).rejects.toSatisfy(
        (err: unknown) => !(err instanceof LLMTransportError),
      );
      await expect(promise).rejects.toHaveProperty('name', 'AbortError');
    });
  });

  describe('non-streaming path', () => {
    it('reads a single JSON completion when stream is disabled', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'plain response' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchMock);

      const provider = createProvider(false);
      const result = await provider.chatCompletion('sys', 'user', REQUEST_OPTIONS);

      expect(result.content).toBe('plain response');
      expect(result.finish_reason).toBe('stop');
      expect(result.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2 });

      const [, requestInit] = fetchMock.mock.calls[0]!;
      const sentBody = JSON.parse((requestInit as RequestInit).body as string);
      expect(sentBody.stream).toBe(false);
      expect(sentBody.stream_options).toBeUndefined();
    });

    it('resolved stream wins over an extraBodyParams.stream override', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        streamingResponse([contentFrame('ok', 'stop'), DONE]),
      );
      vi.stubGlobal('fetch', fetchMock);

      // Constructor resolves streaming on; a caller trying to force stream:false
      // through extraBodyParams must not change the wire transport.
      const provider = createProvider(true);
      await provider.chatCompletion('sys', 'user', {
        ...REQUEST_OPTIONS,
        extraBodyParams: { stream: false },
      });

      const [, requestInit] = fetchMock.mock.calls[0]!;
      const sentBody = JSON.parse((requestInit as RequestInit).body as string);
      expect(sentBody.stream).toBe(true);
    });
  });

  describe('wall-clock request timeout', () => {
    it('aborts a non-streaming request at the configured cap as a transport error', async () => {
      // A non-streaming request sends no bytes until generation finishes, so the
      // fetch stays pending; the cap fires and rejects it with the timeout reason.
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: string, init?: RequestInit) => {
          const sig = init!.signal!;
          return new Promise<Response>((_resolve, reject) => {
            sig.addEventListener('abort', () => reject(sig.reason));
          });
        }),
      );

      const provider = new OpenAIChatProvider({ endpoint: ENDPOINT, stream: false, requestTimeoutMs: 20 });
      const promise = provider.chatCompletion('sys', 'user', REQUEST_OPTIONS);

      await expect(promise).rejects.toBeInstanceOf(LLMTransportError);
      await promise.catch((err: LLMTransportError) => {
        expect(err.causeCode).toBe('REQUEST_TIMEOUT');
        expect(err.message).toContain('wall-clock cap');
      });
    });

    it('fires the cap when a caller signal is present but never aborts', async () => {
      // The combined signal (AbortSignal.any of caller + timeout) exists for
      // exactly this case: a caller signal is wired but only the wall-clock
      // timeout ever fires, so the outcome must be the timeout transport error.
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: string, init?: RequestInit) => {
          const sig = init!.signal!;
          return new Promise<Response>((_resolve, reject) => {
            sig.addEventListener('abort', () => reject(sig.reason));
          });
        }),
      );

      const controller = new AbortController();
      const provider = new OpenAIChatProvider({ endpoint: ENDPOINT, stream: false, requestTimeoutMs: 20 });
      const promise = provider.chatCompletion('sys', 'user', REQUEST_OPTIONS, controller.signal);

      await expect(promise).rejects.toBeInstanceOf(LLMTransportError);
      await promise.catch((err: LLMTransportError) => {
        expect(err.causeCode).toBe('REQUEST_TIMEOUT');
      });
      // The caller never aborted — the cap is what tripped.
      expect(controller.signal.aborted).toBe(false);
    });

    it('decodes a transport fault to its undici cause even when a cap is configured', async () => {
      // A genuine transport fault before the cap fires must decode to its own
      // cause code, not be over-claimed as a timeout just because a cap exists.
      const failure = new TypeError('fetch failed');
      (failure as { cause?: unknown }).cause = { code: 'ECONNRESET' };
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure));

      const provider = new OpenAIChatProvider({ endpoint: ENDPOINT, requestTimeoutMs: 60_000 });
      const promise = provider.chatCompletion('sys', 'user', REQUEST_OPTIONS);

      await expect(promise).rejects.toBeInstanceOf(LLMTransportError);
      await promise.catch((err: LLMTransportError) => {
        expect(err.causeCode).toBe('ECONNRESET');
      });
    });

    it('aborts a streaming request that outlasts the cap as a transport error', async () => {
      // One delta arrives, then the stream stalls; the cap fires mid-stream and
      // the read rejects. A mid-stream cap is a transport fault, not cancellation.
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: string, init?: RequestInit) => {
          const sig = init!.signal!;
          const encoder = new TextEncoder();
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(contentFrame('partial')));
              sig.addEventListener('abort', () => controller.error(sig.reason));
            },
          });
          return Promise.resolve(new Response(body, { status: 200 }));
        }),
      );

      const provider = new OpenAIChatProvider({ endpoint: ENDPOINT, requestTimeoutMs: 20 });
      const promise = provider.chatCompletion('sys', 'user', REQUEST_OPTIONS);

      await expect(promise).rejects.toBeInstanceOf(LLMTransportError);
      await promise.catch((err: LLMTransportError) => {
        expect(err.causeCode).toBe('REQUEST_TIMEOUT');
        expect(err.message).toContain('wall-clock cap');
      });
    });

    it('classifies a caller stop-request as cancellation even when a cap is set', async () => {
      // The caller signal takes precedence over the timeout: an abort from the
      // caller's stop-request must propagate unchanged, never wrapped as a
      // transport error, even with a wall-clock cap also configured.
      const controller = new AbortController();
      const encoder = new TextEncoder();
      let firstRead = true;
      const body = new ReadableStream<Uint8Array>({
        pull(streamController) {
          if (firstRead) {
            firstRead = false;
            streamController.enqueue(encoder.encode(contentFrame('partial')));
            return;
          }
          controller.abort();
          streamController.error(
            Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
          );
        },
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));

      // A generous cap that will not fire during the test — the caller aborts first.
      const provider = new OpenAIChatProvider({ endpoint: ENDPOINT, requestTimeoutMs: 60_000 });
      const promise = provider.chatCompletion('sys', 'user', REQUEST_OPTIONS, controller.signal);

      await expect(promise).rejects.toSatisfy(
        (err: unknown) => !(err instanceof LLMTransportError),
      );
      await expect(promise).rejects.toHaveProperty('name', 'AbortError');
    });

    it('wires the caller signal through unchanged and adds no cap when unset', async () => {
      const fetchMock = vi.fn(() =>
        Promise.resolve(streamingResponse([contentFrame('ok', 'stop'), DONE])),
      );
      vi.stubGlobal('fetch', fetchMock);

      const controller = new AbortController();
      await createProvider().chatCompletion('sys', 'user', REQUEST_OPTIONS, controller.signal);

      // With no cap configured the exact caller signal reaches fetch — nothing
      // is combined or substituted.
      const [, withCaller] = fetchMock.mock.calls[0]!;
      expect((withCaller as RequestInit).signal).toBe(controller.signal);

      fetchMock.mockClear();
      await createProvider().chatCompletion('sys', 'user', REQUEST_OPTIONS);

      // And with neither a cap nor a caller signal, fetch receives no signal.
      const [, withoutCaller] = fetchMock.mock.calls[0]!;
      expect((withoutCaller as RequestInit).signal).toBeUndefined();
    });
  });

  describe('constructor validation', () => {
    it('rejects a non-positive-integer requestTimeoutMs with a typed error', () => {
      for (const bad of [-5, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => new OpenAIChatProvider({ endpoint: ENDPOINT, requestTimeoutMs: bad })).toThrow(
          InvalidInputError,
        );
      }
    });

    it('accepts a positive integer requestTimeoutMs', () => {
      expect(() => new OpenAIChatProvider({ endpoint: ENDPOINT, requestTimeoutMs: 30_000 })).not.toThrow();
    });
  });
});
