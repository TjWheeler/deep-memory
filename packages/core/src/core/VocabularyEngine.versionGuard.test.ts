// Isolated from VocabularyEngine.test.ts because it replaces the governance
// module: the guard under test only fires when governance approves a change
// without advancing the version, which the real governance step never does.

import { describe, it, expect, vi } from 'vitest';
import { VocabularyEngine } from './VocabularyEngine.js';
import { buildVocabulary } from '../vocabulary/VocabularySchema.js';
import type { MemoryVocabulary } from '../types/vocabulary.js';
import type { StorageProvider } from '../providers/StorageProvider.js';
import { VocabularyValidationError } from './errors.js';

vi.mock('../vocabulary/VocabularyGovernor.js', () => ({
  processProposal: (vocabulary: MemoryVocabulary) => ({
    result: { status: 'approved', type: 'team', vocabularyVersion: vocabulary.version },
    updatedVocabulary: { ...vocabulary },
  }),
}));

describe('VocabularyEngine version guard', () => {
  it('refuses to save an approved change that does not advance the version', async () => {
    const stored = buildVocabulary({ entityTypes: [] }, 'test');
    const saveVocabulary = vi.fn<StorageProvider['saveVocabulary']>();
    const storage: Partial<StorageProvider> = {
      getVocabulary: async () => ({ ...stored }),
      saveVocabulary,
    };
    const engine = new VocabularyEngine({
      repositoryId: 'repo-1',
      storageProvider: storage as StorageProvider,
      governanceConfig: { mode: 'open', deduplicationEnabled: false },
    });

    await expect(
      engine.proposeChange(
        { proposalType: 'entity_type', entityType: { type: 'team', description: 'A team' }, justification: 'Need teams' },
        'agent',
      ),
    ).rejects.toThrow(VocabularyValidationError);
    expect(saveVocabulary).not.toHaveBeenCalled();
  });
});
