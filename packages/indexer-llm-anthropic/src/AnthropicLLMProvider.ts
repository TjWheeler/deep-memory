import Anthropic from '@anthropic-ai/sdk';
import { RateLimitError } from '@anthropic-ai/sdk';
import type {
  LLMProvider,
  LLMCompletionResult,
  LLMRequestOptions,
  LLMToolDefinition,
  LLMToolUseMessage,
  LLMToolUseTurnResult,
} from '@utaba/deep-memory-indexer/providers';
import type { UsageSink } from '@utaba/deep-memory/types';
import { createSafeSink } from '@utaba/deep-memory';

const PROVIDER_NAME = 'anthropic';

/** Configuration for the Anthropic LLM provider */
export interface AnthropicLLMProviderConfig {
  /** Anthropic API key */
  apiKey: string;
  /**
   * Enable prompt caching via cache_control markers (default: true).
   * Cached input tokens cost $0.08/M instead of $0.80/M (Haiku) — a 90% reduction.
   * The system prompt (vocabulary + extraction rules) is a perfect cache candidate
   * since it's identical across all chunks within a document extraction.
   */
  enablePromptCaching?: boolean;
  /** Base URL override (for proxy or testing) */
  baseURL?: string;
  /** Maximum number of retries on 429 rate limit errors (default: 5) */
  rateLimitMaxRetries?: number;
  /** Initial backoff in ms when no retry-after header is present (default: 10000) */
  rateLimitInitialBackoffMs?: number;
  /**
   * Optional usage sink. When provided, the provider emits one
   * {@link OperationUsage} record per `chatCompletion` /
   * `chatCompletionWithTools` call reporting total tokens, with an input /
   * output / cache breakdown in `details`.
   */
  reportUsage?: UsageSink;
}

/**
 * Anthropic LLM provider for the extraction pipeline.
 *
 * Uses the Anthropic Messages API natively, enabling:
 * - Prompt caching: system prompt is cached across chunk extractions
 *   (~90% cost reduction on cached tokens)
 * - Proper finish_reason normalization (end_turn → stop, max_tokens → length)
 * - Cache token usage reporting for cost tracking
 */
export class AnthropicLLMProvider implements LLMProvider {
  readonly name = 'anthropic';

  private readonly client: Anthropic;
  private readonly enablePromptCaching: boolean;
  private readonly rateLimitMaxRetries: number;
  private readonly rateLimitInitialBackoffMs: number;
  private readonly reportUsage: UsageSink | undefined;

  constructor(config: AnthropicLLMProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      // The SDK refuses non-streaming requests when it estimates they could
      // exceed the timeout (based on max_tokens). Extraction requests with
      // 64K max_tokens trigger this. Set a generous timeout to prevent the
      // pre-flight rejection — actual request duration is typically 30-120s.
      timeout: 10 * 60 * 1000,
    });
    this.enablePromptCaching = config.enablePromptCaching ?? true;
    this.rateLimitMaxRetries = config.rateLimitMaxRetries ?? 5;
    this.rateLimitInitialBackoffMs = config.rateLimitInitialBackoffMs ?? 10_000;
    this.reportUsage = createSafeSink(config.reportUsage);
  }

  private emitUsage(operation: string, message: Anthropic.Messages.Message): void {
    if (!this.reportUsage) return;
    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    const raw = message.usage as unknown as Record<string, unknown>;
    const cacheReadTokens = typeof raw['cache_read_input_tokens'] === 'number'
      ? (raw['cache_read_input_tokens'] as number)
      : 0;
    const cacheCreationTokens = typeof raw['cache_creation_input_tokens'] === 'number'
      ? (raw['cache_creation_input_tokens'] as number)
      : 0;
    this.reportUsage({
      provider: PROVIDER_NAME,
      operation,
      unit: 'tokens',
      value: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
      timestamp: new Date(),
      details: {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      },
    });
  }

  async chatCompletion(
    systemPrompt: string,
    userPrompt: string,
    options: LLMRequestOptions,
    signal?: AbortSignal,
  ): Promise<LLMCompletionResult> {
    const system: Anthropic.Messages.TextBlockParam[] = [
      {
        type: 'text' as const,
        text: systemPrompt,
        ...(this.enablePromptCaching ? { cache_control: { type: 'ephemeral' as const } } : {}),
      },
    ];

    const createParams = {
      model: options.model,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      system,
      messages: [
        { role: 'user' as const, content: userPrompt },
      ],
    };

    let throttleRetries = 0;
    let throttleTotalBackoffMs = 0;

    // Retry loop for rate limit (429) errors
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const message = await this.client.messages.create(createParams, { signal });
        this.emitUsage('chatCompletion', message);
        return this.buildResult(message, throttleRetries, throttleTotalBackoffMs);
      } catch (error) {
        if (error instanceof RateLimitError && throttleRetries < this.rateLimitMaxRetries) {
          if (signal?.aborted) throw error;

          throttleRetries++;
          const backoffMs = this.resolveBackoffMs(error, throttleRetries);
          throttleTotalBackoffMs += backoffMs;

          // Wait for backoff, but respect abort signal
          await this.sleep(backoffMs, signal);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Send one turn in a multi-turn tool-use conversation.
   *
   * Returns either a text result (conversation complete) or tool calls
   * (caller must execute and send results back for the next turn).
   */
  async chatCompletionWithTools(
    systemPrompt: string,
    messages: LLMToolUseMessage[],
    tools: LLMToolDefinition[],
    options: LLMRequestOptions,
    signal?: AbortSignal,
  ): Promise<LLMToolUseTurnResult> {
    const system: Anthropic.Messages.TextBlockParam[] = [
      {
        type: 'text' as const,
        text: systemPrompt,
        ...(this.enablePromptCaching ? { cache_control: { type: 'ephemeral' as const } } : {}),
      },
    ];

    const anthropicMessages = messages.map(m => toAnthropicMessage(m));

    const createParams: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: options.model,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      system,
      messages: anthropicMessages,
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Messages.Tool['input_schema'],
      })),
    };

    let throttleRetries = 0;
    let throttleTotalBackoffMs = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const message = await this.client.messages.create(createParams, { signal });
        this.emitUsage('chatCompletionWithTools', message);

        const inputTokens = message.usage.input_tokens;
        const outputTokens = message.usage.output_tokens;
        const finish_reason = normalizeStopReason(message.stop_reason);

        // Check if the model wants to make tool calls
        const toolUseBlocks = message.content.filter(
          (block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use',
        );

        if (toolUseBlocks.length > 0) {
          return {
            type: 'tool_use',
            toolCalls: toolUseBlocks.map(block => ({
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown>,
            })),
            usage: { inputTokens, outputTokens },
            finish_reason,
          };
        }

        // Text response — conversation complete
        const textBlock = message.content.find(
          (block): block is Anthropic.Messages.TextBlock => block.type === 'text',
        );

        if (!textBlock) {
          throw new Error('Anthropic returned empty response (no text or tool_use blocks)');
        }

        return {
          type: 'text',
          content: textBlock.text,
          usage: { inputTokens, outputTokens },
          finish_reason,
        };
      } catch (error) {
        if (error instanceof RateLimitError && throttleRetries < this.rateLimitMaxRetries) {
          if (signal?.aborted) throw error;
          throttleRetries++;
          const backoffMs = this.resolveBackoffMs(error, throttleRetries);
          throttleTotalBackoffMs += backoffMs;
          await this.sleep(backoffMs, signal);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Determine backoff duration: prefer retry-after header, fall back to exponential backoff.
   */
  private resolveBackoffMs(error: RateLimitError, attempt: number): number {
    const retryAfter = error.headers?.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (!Number.isNaN(seconds) && seconds > 0) {
        return Math.ceil(seconds * 1000);
      }
    }
    // Exponential backoff: 10s, 20s, 40s, 80s, 160s (with default initial)
    return this.rateLimitInitialBackoffMs * (2 ** (attempt - 1));
  }

  /**
   * Sleep for the given duration, aborting early if the signal fires.
   */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
  }

  private buildResult(
    message: Anthropic.Messages.Message,
    throttleRetries: number,
    throttleTotalBackoffMs: number,
  ): LLMCompletionResult {
    // Extract text content from the response
    const textBlock = message.content.find(block => block.type === 'text');
    const content = textBlock && 'text' in textBlock ? textBlock.text : '';

    if (!content) {
      throw new Error('Anthropic returned empty response');
    }

    // Map usage fields
    const usage: LLMCompletionResult['usage'] = {
      prompt_tokens: message.usage.input_tokens,
      completion_tokens: message.usage.output_tokens,
    };

    // Cache token fields — access via index signature since the SDK types
    // may not expose these on the base Usage interface (they appear when
    // prompt caching is active)
    const rawUsage = message.usage as unknown as Record<string, unknown>;
    if (typeof rawUsage['cache_read_input_tokens'] === 'number') {
      usage.cache_read_tokens = rawUsage['cache_read_input_tokens'] as number;
    }
    if (typeof rawUsage['cache_creation_input_tokens'] === 'number') {
      usage.cache_creation_tokens = rawUsage['cache_creation_input_tokens'] as number;
    }

    const result: LLMCompletionResult = {
      content,
      usage,
      finish_reason: normalizeStopReason(message.stop_reason),
    };

    if (throttleRetries > 0) {
      result.throttle = { retries: throttleRetries, totalBackoffMs: throttleTotalBackoffMs };
    }

    return result;
  }
}

/**
 * Convert a generic LLMToolUseMessage to an Anthropic MessageParam.
 */
function toAnthropicMessage(message: LLMToolUseMessage): Anthropic.Messages.MessageParam {
  if (typeof message.content === 'string') {
    return {
      role: message.role,
      content: message.content,
    };
  }

  type MessageContent = Anthropic.Messages.MessageParam['content'];
  type ContentPart = Exclude<MessageContent, string>[number];

  const contentBlocks = message.content as import('@utaba/deep-memory-indexer/providers').LLMToolUseContent[];
  const content: ContentPart[] = contentBlocks.map(block => {
    if (block.type === 'text') {
      return { type: 'text' as const, text: block.text };
    }
    if (block.type === 'tool_use') {
      return {
        type: 'tool_use' as const,
        id: block.id,
        name: block.name,
        input: block.input,
      };
    }
    // tool_result blocks go in user messages
    return {
      type: 'tool_result' as const,
      tool_use_id: block.tool_use_id,
      content: block.content,
      ...(block.is_error ? { is_error: true } : {}),
    } as ContentPart;
  });

  return { role: message.role, content };
}

/**
 * Normalize Anthropic stop_reason to the standard finish_reason values
 * expected by ExtractionWorker.
 *
 * | Anthropic stop_reason | Normalized finish_reason | ExtractionWorker behavior  |
 * |-----------------------|--------------------------|----------------------------|
 * | end_turn              | stop                     | Normal — parse JSON        |
 * | max_tokens            | length                   | Truncation — salvage/retry |
 * | stop_sequence         | stop                     | Normal — parse JSON        |
 * | tool_use              | stop                     | Not expected in extraction |
 */
function normalizeStopReason(stopReason: string | null): string {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'tool_use':
      return 'stop';
    case 'max_tokens':
      return 'length';
    default:
      return stopReason ?? 'stop';
  }
}
