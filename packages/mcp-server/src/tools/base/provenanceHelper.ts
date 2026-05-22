import type { ProvenanceFilter } from '@utaba/deep-memory';

/** Build a ProvenanceFilter from MCP tool params (conversationId, actor, dateRange) */
export function buildProvenanceFilter(params: Record<string, unknown>): ProvenanceFilter | undefined {
  const conversationId = params['conversationId'] as string | undefined;
  const actor = params['actor'] as string | undefined;
  const dateRange = params['dateRange'] as { from: string; to: string } | undefined;

  if (!conversationId && !actor && !dateRange) return undefined;

  return {
    conversationIds: conversationId ? [conversationId] : undefined,
    actors: actor ? [actor] : undefined,
    dateRange,
  };
}
