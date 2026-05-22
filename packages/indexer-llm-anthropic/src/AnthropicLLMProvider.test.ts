import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicLLMProvider, type AnthropicLLMProviderConfig } from './AnthropicLLMProvider.js';

const { mockCreate, mockConstructor, MockRateLimitError } = vi.hoisted(() => {
  const mockCreate = vi.fn();
  const mockConstructor = vi.fn();

  class MockRateLimitError extends Error {
    readonly status = 429;
    readonly headers: Map<string, string>;

    constructor(message: string, headers?: Record<string, string>) {
      super(message);
      this.name = 'RateLimitError';
      this.headers = new Map(Object.entries(headers ?? {}));
    }
  }

  return { mockCreate, mockConstructor, MockRateLimitError };
});

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
      constructor(opts: unknown) { mockConstructor(opts); }
    },
    RateLimitError: MockRateLimitError,
  };
});

function createProvider(overrides?: Partial<AnthropicLLMProviderConfig>): AnthropicLLMProvider {
  return new AnthropicLLMProvider({
    apiKey: 'test-key',
    ...overrides,
  });
}

function mockSuccessResponse(overrides?: Record<string, unknown>) {
  return {
    content: [{ type: 'text', text: '{"entities": [], "relationships": []}' }],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      ...(overrides?.usage as Record<string, unknown> ?? {}),
    },
    stop_reason: overrides?.stop_reason ?? 'end_turn',
  };
}

describe('AnthropicLLMProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('name', () => {
    it('returns "anthropic"', () => {
      const provider = createProvider();
      expect(provider.name).toBe('anthropic');
    });
  });

  describe('chatCompletion', () => {
    it('sends request in Anthropic Messages API format', async () => {
      mockCreate.mockResolvedValueOnce(mockSuccessResponse());

      const provider = createProvider();
      await provider.chatCompletion(
        'You are a helpful assistant.',
        'Extract entities from this text.',
        { model: 'claude-haiku-4-5-20251001', temperature: 0, maxTokens: 64000 },
      );

      expect(mockCreate).toHaveBeenCalledOnce();
      const [requestBody, requestOptions] = mockCreate.mock.calls[0]!;

      expect(requestBody).toEqual({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 64000,
        temperature: 0,
        system: [
          {
            type: 'text',
            text: 'You are a helpful assistant.',
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          { role: 'user', content: 'Extract entities from this text.' },
        ],
      });

      expect(requestOptions).toEqual({ signal: undefined });
    });

    it('applies cache_control when prompt caching is enabled (default)', async () => {
      mockCreate.mockResolvedValueOnce(mockSuccessResponse());

      const provider = createProvider();
      await provider.chatCompletion('system', 'user', {
        model: 'claude-haiku-4-5-20251001',
        temperature: 0,
        maxTokens: 1024,
      });

      const [body] = mockCreate.mock.calls[0]!;
      expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('omits cache_control when prompt caching is disabled', async () => {
      mockCreate.mockResolvedValueOnce(mockSuccessResponse());

      const provider = createProvider({ enablePromptCaching: false });
      await provider.chatCompletion('system', 'user', {
        model: 'claude-haiku-4-5-20251001',
        temperature: 0,
        maxTokens: 1024,
      });

      const [body] = mockCreate.mock.calls[0]!;
      expect(body.system[0].cache_control).toBeUndefined();
    });

    it('returns content and mapped usage fields', async () => {
      mockCreate.mockResolvedValueOnce(mockSuccessResponse());

      const provider = createProvider();
      const result = await provider.chatCompletion('system', 'user', {
        model: 'claude-haiku-4-5-20251001',
        temperature: 0,
        maxTokens: 1024,
      });

      expect(result.content).toBe('{"entities": [], "relationships": []}');
      expect(result.usage).toEqual({
        prompt_tokens: 100,
        completion_tokens: 50,
      });
    });

    it('maps cache token fields from Anthropic usage', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"entities": [], "relationships": []}' }],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 20,
        },
        stop_reason: 'end_turn',
      });

      const provider = createProvider();
      const result = await provider.chatCompletion('system', 'user', {
        model: 'claude-haiku-4-5-20251001',
        temperature: 0,
        maxTokens: 1024,
      });

      expect(result.usage).toEqual({
        prompt_tokens: 100,
        completion_tokens: 50,
        cache_read_tokens: 80,
        cache_creation_tokens: 20,
      });
    });

    it('passes AbortSignal to the SDK', async () => {
      mockCreate.mockResolvedValueOnce(mockSuccessResponse());

      const controller = new AbortController();
      const provider = createProvider();
      await provider.chatCompletion('system', 'user', {
        model: 'claude-haiku-4-5-20251001',
        temperature: 0,
        maxTokens: 1024,
      }, controller.signal);

      const [, options] = mockCreate.mock.calls[0]!;
      expect(options.signal).toBe(controller.signal);
    });

    it('throws on empty response', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: '' }],
        usage: { input_tokens: 10, output_tokens: 0 },
        stop_reason: 'end_turn',
      });

      const provider = createProvider();
      await expect(
        provider.chatCompletion('system', 'user', {
          model: 'claude-haiku-4-5-20251001',
          temperature: 0,
          maxTokens: 1024,
        }),
      ).rejects.toThrow('Anthropic returned empty response');
    });

    it('throws on response with no text blocks', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [],
        usage: { input_tokens: 10, output_tokens: 0 },
        stop_reason: 'end_turn',
      });

      const provider = createProvider();
      await expect(
        provider.chatCompletion('system', 'user', {
          model: 'claude-haiku-4-5-20251001',
          temperature: 0,
          maxTokens: 1024,
        }),
      ).rejects.toThrow('Anthropic returned empty response');
    });
  });

  describe('finish_reason normalization', () => {
    const testCases: [string | null, string][] = [
      ['end_turn', 'stop'],
      ['max_tokens', 'length'],
      ['stop_sequence', 'stop'],
      ['tool_use', 'stop'],
      [null, 'stop'],
    ];

    for (const [input, expected] of testCases) {
      it(`maps ${String(input)} to ${expected}`, async () => {
        mockCreate.mockResolvedValueOnce(mockSuccessResponse({ stop_reason: input }));

        const provider = createProvider();
        const result = await provider.chatCompletion('s', 'u', {
          model: 'm', temperature: 0, maxTokens: 1024,
        });

        expect(result.finish_reason).toBe(expected);
      });
    }
  });

  describe('rate limit handling', () => {
    it('retries on RateLimitError and returns throttle metadata', async () => {
      mockCreate
        .mockRejectedValueOnce(new MockRateLimitError('rate limited', { 'retry-after': '1' }))
        .mockResolvedValueOnce(mockSuccessResponse());

      const provider = createProvider({ rateLimitInitialBackoffMs: 100 });
      const result = await provider.chatCompletion('system', 'user', {
        model: 'claude-haiku-4-5-20251001', temperature: 0, maxTokens: 1024,
      });

      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(result.content).toBe('{"entities": [], "relationships": []}');
      expect(result.throttle).toEqual({ retries: 1, totalBackoffMs: 1000 });
    });

    it('uses exponential backoff when no retry-after header', async () => {
      mockCreate
        .mockRejectedValueOnce(new MockRateLimitError('rate limited'))
        .mockResolvedValueOnce(mockSuccessResponse());

      const provider = createProvider({ rateLimitInitialBackoffMs: 50 });
      const start = Date.now();
      const result = await provider.chatCompletion('system', 'user', {
        model: 'm', temperature: 0, maxTokens: 1024,
      });
      const elapsed = Date.now() - start;

      expect(result.throttle).toEqual({ retries: 1, totalBackoffMs: 50 });
      expect(elapsed).toBeGreaterThanOrEqual(40); // allow small timing variance
    });

    it('throws after exceeding max retries', async () => {
      mockCreate.mockRejectedValue(new MockRateLimitError('rate limited', { 'retry-after': '0.01' }));

      const provider = createProvider({ rateLimitMaxRetries: 2, rateLimitInitialBackoffMs: 10 });
      await expect(
        provider.chatCompletion('system', 'user', {
          model: 'm', temperature: 0, maxTokens: 1024,
        }),
      ).rejects.toThrow('rate limited');

      // Initial call + 2 retries = 3 total calls
      expect(mockCreate).toHaveBeenCalledTimes(3);
    });

    it('does not include throttle metadata when no rate limiting occurs', async () => {
      mockCreate.mockResolvedValueOnce(mockSuccessResponse());

      const provider = createProvider();
      const result = await provider.chatCompletion('system', 'user', {
        model: 'm', temperature: 0, maxTokens: 1024,
      });

      expect(result.throttle).toBeUndefined();
    });

    it('respects abort signal during rate limit backoff', async () => {
      mockCreate.mockRejectedValueOnce(new MockRateLimitError('rate limited', { 'retry-after': '60' }));

      const controller = new AbortController();
      const provider = createProvider();

      const promise = provider.chatCompletion('system', 'user', {
        model: 'm', temperature: 0, maxTokens: 1024,
      }, controller.signal);

      // Abort while waiting for backoff
      setTimeout(() => controller.abort(), 50);

      await expect(promise).rejects.toThrow();
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('constructor configuration', () => {
    it('passes apiKey and baseURL to Anthropic client', () => {
      createProvider({ apiKey: 'sk-test', baseURL: 'https://proxy.example.com' });

      expect(mockConstructor).toHaveBeenCalledWith({
        apiKey: 'sk-test',
        baseURL: 'https://proxy.example.com',
        timeout: 10 * 60 * 1000,
      });
    });

    it('omits baseURL when not provided', () => {
      createProvider({ apiKey: 'sk-test' });

      expect(mockConstructor).toHaveBeenCalledWith({
        apiKey: 'sk-test',
        timeout: 10 * 60 * 1000,
      });
    });
  });

  describe('usage reporting', () => {
    it('reports aggregated tokens after chatCompletion', async () => {
      mockCreate.mockResolvedValueOnce(mockSuccessResponse({
        usage: {
          input_tokens: 1200,
          output_tokens: 340,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 200,
        },
      }));

      const sink = vi.fn();
      const provider = createProvider({ reportUsage: sink });

      await provider.chatCompletion('sys', 'hi', { model: 'claude-x', maxTokens: 1024, temperature: 0 });

      expect(sink).toHaveBeenCalledTimes(1);
      const [usage] = sink.mock.calls[0]!;
      expect(usage.provider).toBe('anthropic');
      expect(usage.operation).toBe('chatCompletion');
      expect(usage.unit).toBe('tokens');
      expect(usage.value).toBe(1200 + 340 + 800 + 200);
      expect(usage.details).toEqual({
        inputTokens: 1200,
        outputTokens: 340,
        cacheReadTokens: 800,
        cacheCreationTokens: 200,
      });
      expect(usage.timestamp).toBeInstanceOf(Date);
    });

    it('reports tokens after chatCompletionWithTools', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 50, output_tokens: 10 },
        stop_reason: 'end_turn',
      });

      const sink = vi.fn();
      const provider = createProvider({ reportUsage: sink });

      await provider.chatCompletionWithTools(
        'sys',
        [{ role: 'user', content: 'hello' }],
        [],
        { model: 'claude-x', maxTokens: 512, temperature: 0 },
      );

      expect(sink).toHaveBeenCalledTimes(1);
      const [usage] = sink.mock.calls[0]!;
      expect(usage.operation).toBe('chatCompletionWithTools');
      expect(usage.value).toBe(60);
    });

    it('a throwing sink does not break the completion', async () => {
      mockCreate.mockResolvedValueOnce(mockSuccessResponse());

      const provider = createProvider({
        reportUsage: () => { throw new Error('sink is broken'); },
      });

      const result = await provider.chatCompletion('sys', 'hi', { model: 'claude-x', maxTokens: 1024, temperature: 0 });
      expect(result.content).toContain('entities');
    });

    it('does not emit when no sink is configured', async () => {
      mockCreate.mockResolvedValueOnce(mockSuccessResponse());
      const provider = createProvider();
      // No assertion on the sink — just asserting the call works and
      // construction without reportUsage is valid.
      await expect(
        provider.chatCompletion('sys', 'hi', { model: 'claude-x', maxTokens: 1024, temperature: 0 }),
      ).resolves.toBeDefined();
    });
  });
});
