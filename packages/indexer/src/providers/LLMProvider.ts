// ── Tool Use Types ────────────────────────────────────────────────────

/** Definition of a tool the LLM can call */
export interface LLMToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

/** A tool call the LLM wants to make */
export interface LLMToolCallRequest {
  /** Tool call ID (used to match results back to calls) */
  id: string;
  /** Tool name */
  name: string;
  /** Tool input arguments */
  input: Record<string, unknown>;
}

/** Content block in a multi-turn tool-use conversation */
export type LLMToolUseContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

/** A message in a multi-turn tool-use conversation */
export interface LLMToolUseMessage {
  role: 'user' | 'assistant';
  content: string | LLMToolUseContent[];
}

/** Result from a single turn in a tool-use conversation */
export interface LLMToolUseTurnResult {
  /** 'text' — model returned a text response (conversation complete) */
  type: 'text' | 'tool_use';
  /** Present when type === 'text' */
  content?: string;
  /** Present when type === 'tool_use' */
  toolCalls?: LLMToolCallRequest[];
  usage: { inputTokens: number; outputTokens: number };
  finish_reason: string;
}

// ── Standard Completion Types ─────────────────────────────────────────

/** Result from a single LLM chat completion call */
export interface LLMCompletionResult {
  /** The text content of the assistant's response */
  content: string;
  /** Token usage reported by the API */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  };
  /** Why the model stopped — normalized to 'stop' | 'length' */
  finish_reason?: string;
  /** Present when the request was rate-limited and retried before succeeding */
  throttle?: {
    /** Number of 429 retries before the request succeeded */
    retries: number;
    /** Total time spent waiting for rate limit backoff (ms) */
    totalBackoffMs: number;
  };
}

/** Options passed to each chatCompletion call */
export interface LLMRequestOptions {
  model: string;
  temperature: number;
  maxTokens: number;
  extraBodyParams?: Record<string, unknown>;
}

/** Context provided to beforeRun for session-level setup */
export interface LLMRunContext {
  /** The full vocabulary text */
  vocabulary: string;
  /** The extraction rules text, if configured */
  extractionRules?: string;
  /** Domain-specific guidance text, if configured */
  domainGuidance?: string;
  /** Model identifier for this run */
  model: string;
}

/**
 * LLMProvider — pluggable LLM backend for the extraction pipeline.
 *
 * The built-in OpenAIChatProvider uses standard chat completions.
 * Alternative implementations (e.g., Anthropic with Files API)
 * can be provided via separate packages.
 */
export interface LLMProvider {
  /** Human-readable name for logging (e.g., "openai-compat", "anthropic") */
  readonly name: string;

  /**
   * Send a chat completion request.
   * The provider handles API format, authentication, and transport.
   * Returns normalized results regardless of the underlying API.
   */
  chatCompletion(
    systemPrompt: string,
    userPrompt: string,
    options: LLMRequestOptions,
    signal?: AbortSignal,
  ): Promise<LLMCompletionResult>;

  /**
   * Send one turn in a multi-turn tool-use conversation.
   *
   * The caller is responsible for the conversation loop:
   * - When the result type is 'tool_use', execute the tool calls and send
   *   results back as the next turn via the messages array.
   * - When the result type is 'text', the model has finished.
   *
   * Optional — providers that do not support tool use omit this method.
   * Callers must check for its presence before using it.
   */
  chatCompletionWithTools?(
    systemPrompt: string,
    messages: LLMToolUseMessage[],
    tools: LLMToolDefinition[],
    options: LLMRequestOptions,
    signal?: AbortSignal,
  ): Promise<LLMToolUseTurnResult>;

  /**
   * Called once before an extraction run begins.
   * Use for session setup: uploading files, warming caches, etc.
   */
  beforeRun?(context: LLMRunContext): Promise<void>;

  /**
   * Called after an extraction run completes (success or failure).
   * Use for cleanup: deleting uploaded files, closing sessions.
   */
  afterRun?(): Promise<void>;

  /** Teardown — close connections, release resources */
  dispose?(): Promise<void>;
}
