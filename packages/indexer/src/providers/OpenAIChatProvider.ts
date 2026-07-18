import type {
  LLMProvider,
  LLMCompletionResult,
  LLMRequestOptions,
  LLMToolDefinition,
  LLMToolUseMessage,
  LLMToolUseContent,
  LLMToolUseTurnResult,
} from './LLMProvider.js';
import { InvalidInputError } from '@utaba/deep-memory';
import { LLMTransportError } from './errors.js';

/** Configuration for the built-in OpenAI-compatible chat completions provider */
export interface OpenAIChatProviderConfig {
  /** OpenAI-compatible endpoint URL (e.g., "http://localhost:8020/v1") */
  endpoint: string;
  /** API key for authenticated endpoints */
  apiKey?: string;
  /**
   * Consume the completion as a Server-Sent Events stream. Resolves to `true`
   * when unset. Streaming makes response headers arrive immediately and resets
   * the transport idle timer on every token, so a long generation does not
   * outrun the client's idle timeout. Opt out (`false`) only for pathological
   * servers or proxies that do not stream SSE correctly.
   */
  stream?: boolean;
  /**
   * Total wall-clock cap, in milliseconds, on a single completion request.
   * Unset (default) imposes no extra cap. This can only *shorten* a request: it
   * does not extend the ~300s non-streaming time-to-first-byte limit (streaming
   * is the mechanism for long generations). It is a defense-in-depth ceiling on
   * a genuinely stuck request, distinguishable from a caller stop-request. When
   * set it must be a positive integer number of milliseconds.
   */
  requestTimeoutMs?: number;
}

/**
 * The abort signals governing one completion request. `fetch` is the signal
 * actually wired to the transport (the caller's stop-request combined with the
 * wall-clock timeout when a cap is set); `caller` and `timeout` are retained so
 * a thrown abort can be attributed to the right source and classified
 * accordingly.
 */
interface RequestSignals {
  fetch: AbortSignal | undefined;
  caller: AbortSignal | undefined;
  timeout: AbortSignal | undefined;
}

/** One frame of an OpenAI streaming chat-completion response (`stream: true`). */
interface ChatCompletionStreamChunk {
  choices: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
}

/** An OpenAI-compatible error frame delivered mid-stream instead of a delta. */
interface StreamErrorFrame {
  error: {
    message?: string;
    type?: string;
    code?: string;
  };
}

interface ChatCompletionResponse {
  choices: Array<{
    message?: {
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface ToolCallResponse {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatCompletionWithToolsResponse {
  choices: Array<{
    message?: {
      content?: string | null;
      tool_calls?: ToolCallResponse[];
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** OpenAI-format message as sent in the request body */
type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCallResponse[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * Convert internal LLMToolUseMessage[] to OpenAI-format messages.
 *
 * Internal format (Anthropic-inspired):
 *   - user message can contain tool_result content blocks
 *   - assistant message can contain tool_use content blocks
 *
 * OpenAI format:
 *   - tool results are separate messages with role: 'tool'
 *   - tool calls are in assistant message.tool_calls array
 */
function toOpenAIMessages(messages: LLMToolUseMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content } as OpenAIMessage);
      continue;
    }

    const blocks = msg.content as LLMToolUseContent[];

    if (msg.role === 'assistant') {
      const textBlocks = blocks.filter(b => b.type === 'text');
      const toolUseBlocks = blocks.filter(b => b.type === 'tool_use');

      const assistantText = textBlocks.map(b => (b as { type: 'text'; text: string }).text).join('') || null;

      if (toolUseBlocks.length > 0) {
        result.push({
          role: 'assistant',
          content: assistantText,
          tool_calls: toolUseBlocks.map(b => {
            const tb = b as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
            return {
              id: tb.id,
              type: 'function' as const,
              function: {
                name: tb.name,
                arguments: JSON.stringify(tb.input),
              },
            };
          }),
        });
      } else {
        result.push({ role: 'assistant', content: assistantText ?? '' });
      }
    } else {
      // user role — tool_result blocks become individual role: 'tool' messages
      const toolResults = blocks.filter(b => b.type === 'tool_result');
      const textBlocks = blocks.filter(b => b.type === 'text');

      if (toolResults.length > 0) {
        for (const b of toolResults) {
          const tr = b as { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
          result.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: tr.content });
        }
      }

      if (textBlocks.length > 0) {
        const text = textBlocks.map(b => (b as { type: 'text'; text: string }).text).join('');
        result.push({ role: 'user', content: text });
      }
    }
  }

  return result;
}

/**
 * Built-in LLM provider using the OpenAI-compatible chat completions API.
 *
 * This is the default provider when no custom LLMProvider is supplied.
 * Zero additional dependencies — uses the built-in Node.js fetch API.
 *
 * Supports standard chat completions and tool-use (function calling),
 * making it compatible with any vLLM-served model, OpenAI, Azure, or Ollama.
 */
export class OpenAIChatProvider implements LLMProvider {
  readonly name = 'openai-compat';

  /** Resolved once: streaming is the default and only opt-out is explicit `false`. */
  private readonly stream: boolean;

  /** Total wall-clock cap per request in ms; unset means no extra cap. */
  private readonly requestTimeoutMs: number | undefined;

  constructor(private readonly config: OpenAIChatProviderConfig) {
    this.stream = config.stream ?? true;
    // Validate the cap up front so an invalid value fails with a typed,
    // actionable error rather than a raw RangeError/TypeError surfacing later
    // from AbortSignal.timeout(...) on the first request.
    if (
      config.requestTimeoutMs !== undefined &&
      (!Number.isInteger(config.requestTimeoutMs) || config.requestTimeoutMs <= 0)
    ) {
      throw new InvalidInputError(
        'requestTimeoutMs',
        `requestTimeoutMs must be a positive integer number of milliseconds, received ${config.requestTimeoutMs}.`,
      );
    }
    this.requestTimeoutMs = config.requestTimeoutMs;
  }

  /**
   * Build the abort signals for one request. When a wall-clock cap is set, the
   * signal wired to `fetch` is the combination of the caller's stop-request and
   * `AbortSignal.timeout(...)` so the request ends the moment either fires;
   * without a cap the caller signal passes through unchanged. The individual
   * signals are kept so a thrown abort can be attributed to its source.
   */
  private buildRequestSignals(callerSignal?: AbortSignal): RequestSignals {
    if (this.requestTimeoutMs === undefined) {
      return { fetch: callerSignal, caller: callerSignal, timeout: undefined };
    }
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const fetch = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    return { fetch, caller: callerSignal, timeout };
  }

  /**
   * Classify an error thrown by the transport (a rejected `fetch` or a rejected
   * stream read) into what should be thrown to the caller. A combined signal
   * makes an `AbortError` ambiguous, so the source is resolved by precedence:
   *
   * 1. Caller stop-request (its signal aborted) — propagate the original error
   *    unchanged so cancellation is never mistaken for a transport failure.
   * 2. Wall-clock cap fired (only the timeout signal aborted) — a typed
   *    transport error naming the cap.
   * 3. Neither aborted — a genuine transport fault, decoded from `error.cause`.
   *
   * Centralising this keeps the non-streaming and streaming catch sites from
   * drifting: a mid-stream timeout must map to a transport error, not be
   * mistaken for cancellation the way a caller stop-request is.
   */
  private classifyRequestError(err: unknown, signals: RequestSignals): unknown {
    if (signals.caller?.aborted) return err;
    if (signals.timeout?.aborted) {
      return new LLMTransportError(
        this.completionsUrl,
        `request exceeded the ${this.requestTimeoutMs}ms wall-clock cap`,
        { causeCode: 'REQUEST_TIMEOUT' },
      );
    }
    return this.decodeFetchError(err);
  }

  private get baseUrl() {
    return this.config.endpoint.replace(/\/$/, '');
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) h['Authorization'] = `Bearer ${this.config.apiKey}`;
    return h;
  }

  private get completionsUrl(): string {
    return `${this.baseUrl}/chat/completions`;
  }

  public async chatCompletion(
    systemPrompt: string,
    userPrompt: string,
    options: LLMRequestOptions,
    signal?: AbortSignal,
  ): Promise<LLMCompletionResult> {
    // extraBodyParams is spread first so the resolved transport decision always
    // wins over any caller-supplied `stream` — the SSE parser mode below must
    // match what actually went on the wire.
    const streaming = this.stream;
    const body = {
      model: options.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      ...(options.extraBodyParams ?? {}),
      ...(streaming
        ? { stream: true, stream_options: { include_usage: true } }
        : { stream: false }),
    };

    const signals = this.buildRequestSignals(signal);
    const response = await this.postCompletions(body, signals);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new LLMTransportError(this.completionsUrl, errorText || response.statusText, {
        status: response.status,
      });
    }

    if (streaming) {
      return this.readStreamingCompletion(response, signals);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content = data.choices[0]?.message?.content;
    const finishReason = data.choices[0]?.finish_reason;

    if (!content) {
      throw new LLMTransportError(this.completionsUrl, 'endpoint returned an empty response');
    }

    return {
      content,
      usage: data.usage
        ? {
            prompt_tokens: data.usage.prompt_tokens,
            completion_tokens: data.usage.completion_tokens,
          }
        : undefined,
      finish_reason: finishReason,
    };
  }

  /**
   * Issue the POST, classifying a rejected `fetch` by its abort source.
   *
   * A rejected `fetch` hides its real cause in `error.cause.code`
   * (undici idle-timeout / socket codes); a caller stop-request must instead
   * propagate unchanged, and a wall-clock cap must surface as a distinct typed
   * error — {@link classifyRequestError} resolves which applies.
   */
  private async postCompletions(body: unknown, signals: RequestSignals): Promise<Response> {
    try {
      return await fetch(this.completionsUrl, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: signals.fetch,
      });
    } catch (err) {
      throw this.classifyRequestError(err, signals);
    }
  }

  /**
   * Read a streaming (`stream: true`) completion, assembling `delta.content`
   * across network chunks into the same `LLMCompletionResult` the non-streaming
   * path returns, so no caller can observe the transport change.
   *
   * A stream that ends without `data: [DONE]` and without a terminal
   * `finish_reason` is a truncated transport, not a partial success: returning
   * the accumulated content would feed truncated JSON into the salvage path and
   * hide the failure, so it throws instead.
   */
  private async readStreamingCompletion(
    response: Response,
    signals: RequestSignals,
  ): Promise<LLMCompletionResult> {
    if (!response.body) {
      throw new LLMTransportError(this.completionsUrl, 'streaming response had no body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let content = '';
    let finishReason: string | undefined;
    let usage: LLMCompletionResult['usage'];
    let buffer = '';
    let sawDone = false;

    // Process one complete SSE line, updating the accumulators. Shared between
    // the read loop and the post-loop flush so a terminal frame is parsed the
    // same way whether or not the transport terminated it with a newline.
    const consumeLine = (rawLine: string): void => {
      const line = rawLine.trim();
      if (line === '') return;
      // SSE comment / keep-alive lines start with ':' — ignore them.
      if (line.startsWith(':')) return;
      if (!line.startsWith('data:')) return;

      const payload = line.slice('data:'.length).trim();
      if (payload === '[DONE]') {
        sawDone = true;
        return;
      }

      const frame = this.parseStreamFrame(payload);
      if ('error' in frame) {
        const e = frame.error;
        throw new LLMTransportError(
          this.completionsUrl,
          `endpoint reported an error mid-stream: ${e.message ?? e.code ?? 'unknown error'}`,
          { causeCode: e.code },
        );
      }

      const choice = frame.choices[0];
      if (choice) {
        const delta = choice.delta;
        // Accumulate visible content only; GLM emits reasoning_content
        // deltas when thinking is on and those must never reach the caller.
        if (delta?.content) content += delta.content;
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }

      // The include_usage frame arrives with an empty choices array, so
      // choices[0] is undefined here — read usage independently of it.
      if (frame.usage) {
        usage = {
          prompt_tokens: frame.usage.prompt_tokens,
          completion_tokens: frame.usage.completion_tokens,
        };
      }
    };

    try {
      // Reading loop. `reader.read()` rejects with an AbortError when the wired
      // signal fires mid-stream. The abort source decides the outcome: a caller
      // stop-request propagates as cancellation, a wall-clock cap becomes a
      // typed transport error, and every other rejection is decoded as a
      // genuine transport fault.
      for (;;) {
        let chunk: { done: boolean; value?: Uint8Array };
        try {
          chunk = await reader.read();
        } catch (err) {
          throw this.classifyRequestError(err, signals);
        }

        if (chunk.done) break;

        buffer += decoder.decode(chunk.value, { stream: true });

        // Frames are newline-delimited; a JSON object can split across reads,
        // so only consume complete lines and keep the trailing partial in the
        // buffer for the next read.
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          consumeLine(buffer.slice(0, newlineIndex));
          buffer = buffer.slice(newlineIndex + 1);
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Finalize the decoder so a multi-byte UTF-8 codepoint split across the
    // final network chunk is flushed rather than dropped, then process any
    // residual line the transport left without a trailing newline (e.g. a
    // terminal [DONE] or usage frame). This must run before the guard below so
    // a newline-less terminal frame still counts as a clean end.
    buffer += decoder.decode();
    if (buffer.trim() !== '') {
      consumeLine(buffer);
    }

    // A clean end requires the terminal sentinel or a terminal finish_reason.
    // Without either the stream was cut short — fail loudly.
    if (!sawDone && finishReason === undefined) {
      throw new LLMTransportError(
        this.completionsUrl,
        'stream ended before a terminal frame (no [DONE] and no finish_reason)',
      );
    }

    if (!content) {
      throw new LLMTransportError(this.completionsUrl, 'endpoint returned an empty response');
    }

    return { content, usage, finish_reason: finishReason };
  }

  private parseStreamFrame(payload: string): ChatCompletionStreamChunk | StreamErrorFrame {
    try {
      return JSON.parse(payload) as ChatCompletionStreamChunk | StreamErrorFrame;
    } catch {
      throw new LLMTransportError(
        this.completionsUrl,
        `could not parse a streamed frame as JSON`,
      );
    }
  }

  /**
   * Map a rejected `fetch` (or stream read) into a typed transport error,
   * surfacing the undici cause code (`UND_ERR_HEADERS_TIMEOUT`,
   * `UND_ERR_BODY_TIMEOUT`, `UND_ERR_SOCKET`, `ECONNRESET`, …) that a bare
   * `TypeError: fetch failed` buries in `error.cause`.
   */
  private decodeFetchError(err: unknown): LLMTransportError {
    const causeCode = extractCauseCode(err);
    const detail = err instanceof Error ? err.message : String(err);
    return new LLMTransportError(this.completionsUrl, detail, { causeCode });
  }

  /**
   * Tool-use turns stay non-streaming: the full response is generated before
   * headers are sent, so this path is bound by the client's time-to-first-byte
   * limit. Its one short-turn caller has not shown the long-generation failure
   * that motivated streaming the content path, and assembling streamed tool-call
   * fragments would add real complexity for no observed need.
   */
  public async chatCompletionWithTools(
    systemPrompt: string,
    messages: LLMToolUseMessage[],
    tools: LLMToolDefinition[],
    options: LLMRequestOptions,
    signal?: AbortSignal,
  ): Promise<LLMToolUseTurnResult> {
    const body = {
      model: options.model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...toOpenAIMessages(messages),
      ],
      tools: tools.map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      })),
      tool_choice: 'auto',
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      ...(options.extraBodyParams ?? {}),
    };

    const signals = this.buildRequestSignals(signal);
    const response = await this.postCompletions(body, signals);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new LLMTransportError(this.completionsUrl, errorText || response.statusText, {
        status: response.status,
      });
    }

    const data = (await response.json()) as ChatCompletionWithToolsResponse;
    const choice = data.choices[0];
    const msg = choice?.message;
    const finishReason = choice?.finish_reason ?? 'stop';

    const usage = {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    };

    if (msg?.tool_calls && msg.tool_calls.length > 0) {
      return {
        type: 'tool_use',
        toolCalls: msg.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          input: (() => {
            try {
              return JSON.parse(tc.function.arguments) as Record<string, unknown>;
            } catch {
              return {} as Record<string, unknown>;
            }
          })(),
        })),
        usage,
        finish_reason: finishReason,
      };
    }

    // Fallback: some vLLM versions return tool calls as text when the parser
    // doesn't match the model's output format. Try to extract them from content.
    const rawContent = msg?.content ?? '';
    const fallbackCalls = extractToolCallsFromText(rawContent);
    if (fallbackCalls.length > 0) {
      return {
        type: 'tool_use',
        toolCalls: fallbackCalls,
        usage,
        finish_reason: 'tool_calls',
      };
    }

    // Strip thinking tags before returning as text
    const content = rawContent.replace(/^<think>[\s\S]*?<\/think>\s*/i, '').trim();
    return {
      type: 'text',
      content,
      usage,
      finish_reason: finishReason,
    };
  }
}

/**
 * Pull the undici cause code out of a rejected `fetch`. Node's fetch wraps the
 * underlying failure as `TypeError: fetch failed` with the real reason on
 * `error.cause` (an Error carrying a `code` like `UND_ERR_HEADERS_TIMEOUT` or
 * `ECONNRESET`).
 */
function extractCauseCode(err: unknown): string | undefined {
  if (!(err instanceof Error) || !('cause' in err)) return undefined;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object' && 'code' in cause) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * Extract tool calls from raw model text when the vLLM tool-call parser
 * fails to convert them to the standard API format.
 *
 * Handles two formats produced by Qwen/Hermes models:
 *
 * Hermes JSON:
 *   <tool_call>{"name": "fn", "arguments": {...}}</tool_call>
 *
 * Qwen XML:
 *   <tool_call><function=fn><parameter=key>value</parameter></function></tool_call>
 */
function extractToolCallsFromText(content: string): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  // Strip thinking block first
  const text = content.replace(/^<think>[\s\S]*?<\/think>\s*/i, '').trim();

  const calls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  let callIndex = 0;

  // Match all <tool_call>...</tool_call> blocks
  const blockRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRegex.exec(text)) !== null) {
    const inner = blockMatch[1]!.trim();

    // Try hermes JSON format: {"name": "...", "arguments": {...}}
    try {
      const parsed = JSON.parse(inner) as { name?: string; arguments?: Record<string, unknown> };
      if (parsed.name) {
        calls.push({
          id: `fallback-${callIndex++}`,
          name: parsed.name,
          input: parsed.arguments ?? {},
        });
        continue;
      }
    } catch {
      // Not valid JSON — try XML format below
    }

    // Try Qwen XML format: <function=name><parameter=key>value</parameter></function>
    const fnMatch = /<function=([^>]+)>([\s\S]*?)<\/function>/i.exec(inner);
    if (fnMatch) {
      const fnName = fnMatch[1]!.trim();
      const fnBody = fnMatch[2]!;
      const input: Record<string, unknown> = {};

      const paramRegex = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/gi;
      let paramMatch: RegExpExecArray | null;
      while ((paramMatch = paramRegex.exec(fnBody)) !== null) {
        const key = paramMatch[1]!.trim();
        const value = paramMatch[2]!.trim();
        // Coerce numeric strings to numbers
        const num = Number(value);
        input[key] = value !== '' && !Number.isNaN(num) ? num : value;
      }

      calls.push({ id: `fallback-${callIndex++}`, name: fnName, input });
    }
  }

  return calls;
}
