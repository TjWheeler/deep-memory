import type { IndexingOrchestrator, WorkerConfig } from '@utaba/deep-memory-indexer';
import type { LLMProvider } from '@utaba/deep-memory-indexer/providers';
import { AnthropicLLMProvider } from '@utaba/deep-memory-indexer-llm-anthropic';

/**
 * Resolve and register LLM providers on an orchestrator based on worker configs.
 *
 * Scans the extraction worker pool for workers with `llmProvider` set.
 * Currently supported providers:
 * - "anthropic": uses @utaba/deep-memory-indexer-llm-anthropic
 */
export async function registerLLMProviders(
  orchestrator: IndexingOrchestrator,
  workers: WorkerConfig[] | undefined,
): Promise<void> {
  if (!workers || workers.length === 0) return;

  const providerNames = new Set<string>();
  for (const worker of workers) {
    if (worker.llmProvider) {
      providerNames.add(worker.llmProvider);
    }
  }

  if (providerNames.size === 0) return;

  for (const name of providerNames) {
    const provider = await createProvider(name, workers);
    if (provider) {
      orchestrator.registerLLMProvider(name, provider);
    }
  }
}

async function createProvider(
  name: string,
  workers: WorkerConfig[],
): Promise<LLMProvider | null> {
  switch (name) {
    case 'anthropic':
      return createAnthropicProvider(workers);
    default:
      return null;
  }
}

function createAnthropicProvider(workers: WorkerConfig[]): LLMProvider {
  const anthropicWorker = workers.find(w => w.llmProvider === 'anthropic');
  if (!anthropicWorker?.apiKey) {
    throw new Error(
      'Workers with llmProvider: "anthropic" must have an apiKey configured. ' +
      'Add the API key to config.secrets.json under extraction.workers.<worker-name>.apiKey',
    );
  }

  return new AnthropicLLMProvider({ apiKey: anthropicWorker.apiKey });
}
