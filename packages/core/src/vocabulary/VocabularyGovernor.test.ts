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

  it('flags a delete of an undeclared type as typeAbsent, and no other rejection', () => {
    const config: GovernanceConfig = { mode: 'open' };
    const absentEntity = processProposal(
      baseVocab,
      { proposalType: 'delete_entity_type', deleteEntityType: { type: 'project' }, justification: 'Gone' },
      config,
      { proposedBy: 'agent' },
    );
    expect(absentEntity.typeAbsent).toBe(true);
    expect(absentEntity.result.status).toBe('rejected');
    expect(absentEntity.result.reason).toContain('not found');
    expect(absentEntity.updatedVocabulary).toBeUndefined();
    expect(absentEntity.changeRecord).toBeUndefined();

    const absentRelationship = processProposal(
      baseVocab,
      { proposalType: 'delete_relationship_type', deleteRelationshipType: { type: 'KNOWS' }, justification: 'Gone' },
      config,
      { proposedBy: 'agent' },
    );
    expect(absentRelationship.typeAbsent).toBe(true);
    expect(absentRelationship.result.status).toBe('rejected');

    const declared = processProposal(
      baseVocab,
      { proposalType: 'delete_entity_type', deleteEntityType: { type: 'person' }, justification: 'Remove' },
      config,
      { proposedBy: 'agent' },
    );
    expect(declared.typeAbsent).toBeUndefined();
    expect(declared.result.status).toBe('approved');
    expect(declared.changeRecord?.changeType).toBe('entity_type_removed');

    const absentEdit = processProposal(
      baseVocab,
      { proposalType: 'edit_entity_type', editEntityType: { type: 'project', description: 'x' }, justification: 'Edit' },
      config,
      { proposedBy: 'agent' },
    );
    expect(absentEdit.result.status).toBe('rejected');
    expect(absentEdit.typeAbsent).toBeUndefined();

    const locked = processProposal(
      baseVocab,
      { proposalType: 'delete_entity_type', deleteEntityType: { type: 'project' }, justification: 'Gone' },
      { mode: 'locked' },
      { proposedBy: 'agent' },
    );
    expect(locked.result.status).toBe('rejected');
    expect(locked.typeAbsent).toBeUndefined();
  });

  it('resolves a relationship type delete to its SCREAMING_SNAKE_CASE name', () => {
    const config: GovernanceConfig = { mode: 'open' };
    const withWorksOn = processProposal(baseVocab, relProposal, config, { proposedBy: 'admin' }).updatedVocabulary!;
    expect(withWorksOn.relationshipTypes.map((rt) => rt.type)).toEqual(['WORKS_ON']);

    const deleted = processProposal(
      withWorksOn,
      { proposalType: 'delete_relationship_type', deleteRelationshipType: { type: 'worksOn' }, justification: 'Remove' },
      config,
      { proposedBy: 'agent' },
    );
    expect(deleted.result).toMatchObject({ status: 'approved', type: 'WORKS_ON' });
    expect(deleted.updatedVocabulary?.relationshipTypes).toEqual([]);
    expect(deleted.changeRecord?.typeName).toBe('WORKS_ON');

    const absent = processProposal(
      baseVocab,
      { proposalType: 'delete_relationship_type', deleteRelationshipType: { type: 'reports to' }, justification: 'Gone' },
      config,
      { proposedBy: 'agent' },
    );
    expect(absent.typeAbsent).toBe(true);
    expect(absent.result.type).toBe('REPORTS_TO');
  });

  it('reports a relationship type add under the SCREAMING_SNAKE_CASE name it stores', () => {
    const config: GovernanceConfig = { mode: 'open' };
    const added = processProposal(baseVocab, relProposal, config, { proposedBy: 'agent' });
    expect(added.result).toMatchObject({ status: 'approved', type: 'WORKS_ON' });
    expect(added.updatedVocabulary?.relationshipTypes.map((rt) => rt.type)).toEqual(['WORKS_ON']);
    expect(added.changeRecord?.typeName).toBe('WORKS_ON');
  });

  it('edits a relationship type named in any casing, and reports the stored name', () => {
    const config: GovernanceConfig = { mode: 'open' };
    const withWorksOn = processProposal(baseVocab, relProposal, config, { proposedBy: 'admin' }).updatedVocabulary!;

    const edited = processProposal(
      withWorksOn,
      {
        proposalType: 'edit_relationship_type',
        editRelationshipType: { type: 'worksOn', description: 'Person contributes to project' },
        justification: 'Clarify',
      },
      config,
      { proposedBy: 'agent' },
    );
    expect(edited.result).toMatchObject({ status: 'approved', type: 'WORKS_ON' });
    expect(edited.updatedVocabulary?.relationshipTypes).toHaveLength(1);
    expect(edited.updatedVocabulary?.relationshipTypes[0]).toMatchObject({
      type: 'WORKS_ON',
      description: 'Person contributes to project',
    });
    expect(edited.changeRecord?.typeName).toBe('WORKS_ON');

    const absent = processProposal(
      withWorksOn,
      {
        proposalType: 'edit_relationship_type',
        editRelationshipType: { type: 'reports to', description: 'x' },
        justification: 'Edit',
      },
      config,
      { proposedBy: 'agent' },
    );
    expect(absent.result).toMatchObject({ status: 'rejected', type: 'REPORTS_TO' });
    expect(absent.updatedVocabulary).toBeUndefined();
  });

  it('edits a stored relationship type whose name is not in SCREAMING_SNAKE_CASE by its exact name', () => {
    const config: GovernanceConfig = { mode: 'open' };
    const legacy = {
      ...baseVocab,
      relationshipTypes: [{ ...processProposal(baseVocab, relProposal, config, { proposedBy: 'admin' })
        .updatedVocabulary!.relationshipTypes[0]!, type: 'works_on' }],
    };

    const edited = processProposal(
      legacy,
      {
        proposalType: 'edit_relationship_type',
        editRelationshipType: { type: 'works_on', description: 'Edited' },
        justification: 'Clarify',
      },
      config,
      { proposedBy: 'agent' },
    );
    expect(edited.result).toMatchObject({ status: 'approved', type: 'works_on' });
    expect(edited.updatedVocabulary?.relationshipTypes.map((rt) => rt.type)).toEqual(['works_on']);
  });

  it('deletes a relationship type by its exact name when converting the name would change it', () => {
    // The conversion is not idempotent: HAS_A1B converts to HAS_A1_B, so a
    // type declared as HAS_A1B is reachable only by its exact name.
    const config: GovernanceConfig = { mode: 'open' };
    const template = processProposal(baseVocab, relProposal, config, { proposedBy: 'admin' })
      .updatedVocabulary!.relationshipTypes[0]!;
    const vocabulary = { ...baseVocab, relationshipTypes: [{ ...template, type: 'HAS_A1B' }] };
    const deleteProposal = (type: string): VocabularyProposal => ({
      proposalType: 'delete_relationship_type',
      deleteRelationshipType: { type },
      justification: 'Remove',
    });

    const exact = processProposal(vocabulary, deleteProposal('HAS_A1B'), config, { proposedBy: 'agent' });
    expect(exact.result).toMatchObject({ status: 'approved', type: 'HAS_A1B' });
    expect(exact.updatedVocabulary?.relationshipTypes).toEqual([]);
    expect(exact.changeRecord).toMatchObject({ changeType: 'relationship_type_removed', typeName: 'HAS_A1B' });

    const lowerCase = processProposal(vocabulary, deleteProposal('has_a1b'), config, { proposedBy: 'agent' });
    expect(lowerCase.result).toMatchObject({ status: 'approved', type: 'HAS_A1B' });

    const otherName = processProposal(vocabulary, deleteProposal('HAS_A1_B'), config, { proposedBy: 'agent' });
    expect(otherName.result).toMatchObject({ status: 'rejected', type: 'HAS_A1_B' });
    expect(otherName.typeAbsent).toBe(true);
  });

  it('deletes a relationship type by its converted name when no type has the exact name', () => {
    const config: GovernanceConfig = { mode: 'open' };
    const declared = processProposal(baseVocab, relProposal, config, { proposedBy: 'admin' }).updatedVocabulary!;

    const deleted = processProposal(
      declared,
      { proposalType: 'delete_relationship_type', deleteRelationshipType: { type: 'worksOn' }, justification: 'Remove' },
      config,
      { proposedBy: 'agent' },
    );
    expect(deleted.result).toMatchObject({ status: 'approved', type: 'WORKS_ON' });
    expect(deleted.updatedVocabulary?.relationshipTypes).toEqual([]);
  });
});
