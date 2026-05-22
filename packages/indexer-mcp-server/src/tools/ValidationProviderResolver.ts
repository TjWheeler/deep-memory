import type { IndexingOrchestrator } from '@utaba/deep-memory-indexer';
import type { FullValidationConfig, FullValidationWorkerConfig } from '@utaba/deep-memory-indexer';
import type { LLMProvider } from '@utaba/deep-memory-indexer/providers';
import { OpenAIChatProvider } from '@utaba/deep-memory-indexer/providers';
import { AnthropicLLMProvider } from '@utaba/deep-memory-indexer-llm-anthropic';

/**
 * Resolve and register LLM providers on an orchestrator based on full validation worker configs.
 *
 * Two provider types are supported:
 * - "anthropic": Anthropic Messages API with native tool use.
 * - OpenAI-compatible (no llmProvider): Built-in OpenAI-compatible provider.
 */
export async function registerValidationProviders(
  orchestrator: IndexingOrchestrator,
  config: FullValidationConfig,
): Promise<void> {
  if (!config.workers || config.workers.length === 0) return;

  const cloudProviderNames = new Set<string>();
  for (const worker of config.workers) {
    if (worker.llmProvider) {
      cloudProviderNames.add(worker.llmProvider);
    }
  }

  for (const name of cloudProviderNames) {
    const provider = await createCloudProvider(name, config);
    if (provider) {
      orchestrator.registerLLMProvider(name, provider);
    }
  }

  for (const worker of config.workers) {
    if (!worker.llmProvider) {
      const provider = createLocalProvider(worker);
      if (provider) {
        orchestrator.registerLLMProvider(worker.name, provider);
      }
    }
  }
}

async function createCloudProvider(
  name: string,
  config: FullValidationConfig,
): Promise<LLMProvider | null> {
  switch (name) {
    case 'anthropic':
      return createAnthropicProvider(config);
    default:
      return null;
  }
}

function createLocalProvider(worker: FullValidationWorkerConfig): LLMProvider | null {
  if (!worker.endpoint) {
    throw new Error(
      `Validation worker "${worker.name}" has no llmProvider and no endpoint. ` +
      'Local workers must specify an endpoint (e.g., "http://localhost:8020/v1").',
    );
  }
  return new OpenAIChatProvider({
    endpoint: worker.endpoint,
    ...(worker.apiKey ? { apiKey: worker.apiKey } : {}),
  });
}

function createAnthropicProvider(config: FullValidationConfig): LLMProvider {
  const anthropicWorker = config.workers.find(w => w.llmProvider === 'anthropic');
  if (!anthropicWorker?.apiKey) {
    throw new Error(
      'Validation workers with llmProvider: "anthropic" must have an apiKey. ' +
      'Add it to config.secrets.json under validation.workers.<worker-name>.apiKey',
    );
  }

  return new AnthropicLLMProvider({ apiKey: anthropicWorker.apiKey });
}
