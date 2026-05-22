import { describe, it, expect } from 'vitest';
import { canPropose, processProposal } from './VocabularyGovernor.js';
import { buildVocabulary } from './VocabularySchema.js';
import type { GovernanceConfig, VocabularyProposal } from '../types/vocabulary.js';

const baseVocab = buildVocabulary(
  {
    entityTypes: [{ type: 'person', description: 'A person' }],
    relationshipTypes: [],
  },
  'admin',
);

const entityProposal: VocabularyProposal = {
  proposalType: 'entity_type',
  entityType: { type: 'project', description: 'A project' },
  justification: 'Need to track projects',
};

const relProposal: VocabularyProposal = {
  proposalType: 'relationship_type',
  relationshipType: {
    type: 'works_on',
    description: 'Person works on project',
    allowedSourceTypes: ['person'],
    allowedTargetTypes: ['project'],
  },
  justification: 'Connect people to projects',
};

describe('canPropose', () => {
  it('denies proposals in locked mode', () => {
    const decision = canPropose({ mode: 'locked' }, entityProposal);
    expect(decision.allowed).toBe(false);
  });

  it('allows proposals in managed mode', () => {
    const decision = canPropose({ mode: 'managed' }, entityProposal);
    expect(decision.allowed).toBe(true);
  });

  it('allows proposals in open mode', () => {
    const decision = canPropose({ mode: 'open' }, entityProposal);
    expect(decision.allowed).toBe(true);
  });
});

describe('processProposal', () => {
  it('rejects in locked mode', () => {
    const config: GovernanceConfig = { mode: 'locked' };
    const { result } = processProposal(baseVocab, entityProposal, config, {
      proposedBy: 'agent',
    });
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('locked');
  });

  it('approves entity type in open mode', () => {
    const config: GovernanceConfig = { mode: 'open' };
    const { result, updatedVocabulary } = processProposal(
      baseVocab,
      entityProposal,
      config,
      { proposedBy: 'agent' },
    );
    expect(result.status).toBe('approved');
    expect(result.vocabularyVersion).toBeTruthy();
    expect(updatedVocabulary).toBeDefined();
    expect(updatedVocabulary!.entityTypes).toHaveLength(2);
    expect(updatedVocabulary!.entityTypes[1]!.type).toBe('project');
  });

  it('approves relationship type in open mode', () => {
    const config: GovernanceConfig = { mode: 'open' };
    const { result, updatedVocabulary } = processProposal(
      baseVocab,
      relProposal,
      config,
      { proposedBy: 'agent' },
    );
    expect(result.status).toBe('approved');
    expect(updatedVocabulary!.relationshipTypes).toHaveLength(1);
    expect(updatedVocabulary!.relationshipTypes[0]!.type).toBe('WORKS_ON');
  });

  it('queues for approval in managed mode with requireApproval', () => {
    const config: GovernanceConfig = { mode: 'managed', requireApproval: true };
    const { result, updatedVocabulary } = processProposal(
      baseVocab,
      entityProposal,
      config,
      { proposedBy: 'agent' },
    );
    expect(result.status).toBe('pending_approval');
    expect(result.proposalId).toBeTruthy();
    expect(updatedVocabulary).toBeUndefined();
  });

  it('auto-approves in managed mode without requireApproval', () => {
    const config: GovernanceConfig = { mode: 'managed' };
    const { result } = processProposal(baseVocab, entityProposal, config, {
      proposedBy: 'agent',
    });
    expect(result.status).toBe('approved');
  });

  it('rejects when duplicates found', () => {
    const config: GovernanceConfig = { mode: 'open' };
    const { result } = processProposal(baseVocab, entityProposal, config, {
      proposedBy: 'agent',
      duplicates: [{ type: 'project_item', description: 'Similar', similarity: 0.9 }],
    });
    expect(result.status).toBe('rejected');
    expect(result.duplicates).toHaveLength(1);
  });

  it('increments vocabulary version on approval', () => {
    const config: GovernanceConfig = { mode: 'open' };
    const { updatedVocabulary } = processProposal(baseVocab, entityProposal, config, {
      proposedBy: 'agent',
    });
    // baseVocab is version 1.0.0, should increment to 1.1.0 (minor)
    expect(updatedVocabulary!.version).toBe('1.1.0');
  });

  it('produces a change record on approval', () => {
    const config: GovernanceConfig = { mode: 'open' };
    const { changeRecord } = processProposal(baseVocab, entityProposal, config, {
      proposedBy: 'agent',
    });
    expect(changeRecord).toBeDefined();
    expect(changeRecord!.changeType).toBe('entity_type_added');
    expect(changeRecord!.typeName).toBe('project');
    expect(changeRecord!.proposedBy).toBe('agent');
  });
});
