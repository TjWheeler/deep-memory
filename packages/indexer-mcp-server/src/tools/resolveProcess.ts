import { join, resolve } from 'node:path';
import { loadProcessConfig } from '@utaba/deep-memory-indexer';
import type { OrchestratorConfig } from '@utaba/deep-memory-indexer';

/** Resolve stateDir from processDir or direct stateDir param */
export function resolveStateDir(params: Record<string, unknown>): string {
  const processDir = params['processDir'] as string | undefined;
  if (processDir) {
    return join(resolve(processDir), 'state');
  }
  const stateDir = params['stateDir'] as string | undefined;
  if (!stateDir) {
    throw new Error('Either processDir or stateDir is required');
  }
  return stateDir;
}

/**
 * Resolve MCP tool params into an OrchestratorConfig + sourceDir.
 *
 * If `processDir` is provided, loads config.json + config.secrets.json from that
 * directory. Individual params act as overrides.
 */
export async function resolveConfig(
  params: Record<string, unknown>,
): Promise<{ config: OrchestratorConfig; sourceDir: string }> {
  const processDir = params['processDir'] as string | undefined;

  if (!processDir) {
    throw new Error('processDir is required');
  }

  const { config, sourceDir } = await loadProcessConfig(processDir, {
    maxItems: params['maxItems'] as number | undefined,
    sourceFilter: params['sourceFilter'] as string[] | undefined,
    autoReassignFailures: params['autoReassignFailures'] as boolean | undefined,
    sourceDir: params['sourceDir'] as string | undefined,
  });
  return { config, sourceDir };
}

/** Format milliseconds into a human-readable duration string */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}
