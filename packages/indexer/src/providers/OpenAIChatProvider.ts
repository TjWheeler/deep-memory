import type {
  LLMProvider,
  LLMCompletionResult,
  LLMRequestOptions,
  LLMToolDefinition,
  LLMToolUseMessage,
  LLMToolUseContent,
  LLMToolUseTurnResult,
} from './LLMProvider.js';

/** Configuration for the built-in OpenAI-compatible chat completions provider */
export interface OpenAIChatProviderConfig {
  /** OpenAI-compatible endpoint URL (e.g., "http://localhost:8020/v1") */
  endpoint: string;
  /** API key for authenticated endpoints */
  apiKey?: string;
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

  constructor(private readonly config: OpenAIChatProviderConfig) {}

  private get baseUrl() {
    return this.config.endpoint.replace(/\/$/, '');
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) h['Authorization'] = `Bearer ${this.config.apiKey}`;
    return h;
  }

  async chatCompletion(
    systemPrompt: string,
    userPrompt: string,
    options: LLMRequestOptions,
    signal?: AbortSignal,
  ): Promise<LLMCompletionResult> {
    const body = {
      model: options.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      ...(options.extraBodyParams ?? {}),
    };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content = data.choices[0]?.message?.content;
    const finishReason = data.choices[0]?.finish_reason;

    if (!content) {
      throw new Error('LLM returned empty response');
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

  async chatCompletionWithTools(
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

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API error (${response.status}): ${errorText}`);
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
