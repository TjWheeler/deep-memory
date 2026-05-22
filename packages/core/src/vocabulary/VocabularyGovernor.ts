// VocabularyGovernor — implements governance modes for vocabulary evolution

import type {
  GovernanceConfig,
  MemoryVocabulary,
  VocabularyProposal,
  VocabularyProposalResult,
  VocabularyChangeRecord,
} from '../types/vocabulary.js';
import {
  createEntityTypeDefinition,
  createRelationshipTypeDefinition,
  incrementVersion,
  mergeEntityTypeEdit,
  mergeRelationshipTypeEdit,
} from './VocabularySchema.js';

/** Why a proposal was denied */
export interface GovernanceDenial {
  allowed: false;
  reason: string;
}

/** Proposal is allowed to proceed */
export interface GovernanceApproval {
  allowed: true;
}

export type GovernanceDecision = GovernanceDenial | GovernanceApproval;

/** Check whether a proposal is allowed under the given governance mode */
export function canPropose(
  governanceConfig: GovernanceConfig,
  _proposal: VocabularyProposal,
): GovernanceDecision {
  switch (governanceConfig.mode) {
    case 'locked':
      return {
        allowed: false,
        reason:
          'Vocabulary is locked. Only organization admins can modify the vocabulary via the admin API.',
      };
    case 'managed':
    case 'open':
      return { allowed: true };
  }
}

export interface ProcessProposalOptions {
  /** Pre-checked deduplication result — if duplicates were found, pass them here */
  duplicates?: Array<{ type: string; description: string; similarity: number }>;
  /** The actor proposing the change */
  proposedBy: string;
}

/**
 * Process a vocabulary proposal according to governance rules.
 * Returns the updated vocabulary (if approved) and a proposal result.
 */
export function processProposal(
  vocabulary: MemoryVocabulary,
  proposal: VocabularyProposal,
  governanceConfig: GovernanceConfig,
  options: ProcessProposalOptions,
): {
  result: VocabularyProposalResult;
  updatedVocabulary?: MemoryVocabulary;
  changeRecord?: VocabularyChangeRecord;
} {
  const decision = canPropose(governanceConfig, proposal);
  if (!decision.allowed) {
    return {
      result: {
        status: 'rejected',
        type: getProposedTypeName(proposal),
        reason: decision.reason,
      },
    };
  }

  // Edit and delete proposals skip deduplication
  const isAddProposal =
    proposal.proposalType === 'entity_type' || proposal.proposalType === 'relationship_type';

  // If duplicates were found (add proposals only), reject
  if (isAddProposal && options.duplicates && options.duplicates.length > 0) {
    return {
      result: {
        status: 'rejected',
        type: getProposedTypeName(proposal),
        reason: `Similar type(s) already exist in the vocabulary`,
        duplicates: options.duplicates,
      },
    };
  }

  // Managed mode with requireApproval — queue for human approval
  if (governanceConfig.mode === 'managed' && governanceConfig.requireApproval) {
    return {
      result: {
        status: 'pending_approval',
        type: getProposedTypeName(proposal),
        proposalId: generateProposalId(),
      },
    };
  }

  // Auto-approve: managed (without requireApproval) or open
  switch (proposal.proposalType) {
    case 'entity_type':
    case 'relationship_type':
      return applyAddProposal(vocabulary, proposal, options.proposedBy);
    case 'edit_entity_type':
    case 'edit_relationship_type':
      return applyEditProposal(vocabulary, proposal, options.proposedBy);
    case 'delete_entity_type':
    case 'delete_relationship_type':
      return applyDeleteProposal(vocabulary, proposal, options.proposedBy);
  }
}

/** Apply an add proposal to the vocabulary */
function applyAddProposal(
  vocabulary: MemoryVocabulary,
  proposal: VocabularyProposal,
  proposedBy: string,
): {
  result: VocabularyProposalResult;
  updatedVocabulary: MemoryVocabulary;
  changeRecord: VocabularyChangeRecord;
} {
  const now = new Date().toISOString();
  const newVersion = incrementVersion(vocabulary.version, 'minor');
  const typeName = getProposedTypeName(proposal);

  let updatedVocabulary: MemoryVocabulary;
  let changeType: VocabularyChangeRecord['changeType'];

  if (proposal.proposalType === 'entity_type' && proposal.entityType) {
    const newType = createEntityTypeDefinition(proposal.entityType, proposedBy);
    updatedVocabulary = {
      ...vocabulary,
      version: newVersion,
      lastModified: now,
      modifiedBy: proposedBy,
      entityTypes: [...vocabulary.entityTypes, newType],
    };
    changeType = 'entity_type_added';
  } else if (proposal.proposalType === 'relationship_type' && proposal.relationshipType) {
    const newType = createRelationshipTypeDefinition(
      {
        type: proposal.relationshipType.type,
        description: proposal.relationshipType.description,
        allowedSourceTypes: proposal.relationshipType.allowedSourceTypes,
        allowedTargetTypes: proposal.relationshipType.allowedTargetTypes,
        bidirectional: proposal.relationshipType.bidirectional,
        properties: proposal.relationshipType.properties,
      },
      proposedBy,
    );
    updatedVocabulary = {
      ...vocabulary,
      version: newVersion,
      lastModified: now,
      modifiedBy: proposedBy,
      relationshipTypes: [...vocabulary.relationshipTypes, newType],
    };
    changeType = 'relationship_type_added';
  } else {
    return {
      result: {
        status: 'rejected',
        type: typeName,
        reason: 'Invalid proposal: missing type definition for the specified proposal type',
      },
      updatedVocabulary: vocabulary,
      changeRecord: {
        changeId: generateChangeId(),
        changeType: 'entity_type_added',
        typeName,
        newVersion: vocabulary.version,
        proposedBy,
        proposedAt: now,
        reason: proposal.justification,
      },
    };
  }

  const changeRecord: VocabularyChangeRecord = {
    changeId: generateChangeId(),
    changeType,
    typeName,
    previousVersion: vocabulary.version,
    newVersion,
    proposedBy,
    proposedAt: now,
    approvedAt: now,
    reason: proposal.justification,
  };

  return {
    result: { status: 'approved', type: typeName, vocabularyVersion: newVersion },
    updatedVocabulary,
    changeRecord,
  };
}

/** Apply an edit proposal to the vocabulary */
function applyEditProposal(
  vocabulary: MemoryVocabulary,
  proposal: VocabularyProposal,
  proposedBy: string,
): {
  result: VocabularyProposalResult;
  updatedVocabulary?: MemoryVocabulary;
  changeRecord?: VocabularyChangeRecord;
} {
  const now = new Date().toISOString();
  const typeName = getProposedTypeName(proposal);
  const newVersion = incrementVersion(vocabulary.version, 'minor');

  let updatedVocabulary: MemoryVocabulary;
  let changeType: VocabularyChangeRecord['changeType'];

  if (proposal.proposalType === 'edit_entity_type' && proposal.editEntityType) {
    const existing = vocabulary.entityTypes.find((et) => et.type === proposal.editEntityType!.type);
    if (!existing) {
      return {
        result: {
          status: 'rejected',
          type: typeName,
          reason: `Entity type "${typeName}" not found in vocabulary`,
        },
      };
    }
    const merged = mergeEntityTypeEdit(existing, proposal.editEntityType, proposedBy);
    updatedVocabulary = {
      ...vocabulary,
      version: newVersion,
      lastModified: now,
      modifiedBy: proposedBy,
      entityTypes: vocabulary.entityTypes.map((et) => (et.type === typeName ? merged : et)),
    };
    changeType = 'entity_type_modified';
  } else if (proposal.proposalType === 'edit_relationship_type' && proposal.editRelationshipType) {
    const existing = vocabulary.relationshipTypes.find(
      (rt) => rt.type === proposal.editRelationshipType!.type,
    );
    if (!existing) {
      return {
        result: {
          status: 'rejected',
          type: typeName,
          reason: `Relationship type "${typeName}" not found in vocabulary`,
        },
      };
    }
    const merged = mergeRelationshipTypeEdit(existing, proposal.editRelationshipType, proposedBy);
    updatedVocabulary = {
      ...vocabulary,
      version: newVersion,
      lastModified: now,
      modifiedBy: proposedBy,
      relationshipTypes: vocabulary.relationshipTypes.map((rt) =>
        rt.type === typeName ? merged : rt,
      ),
    };
    changeType = 'relationship_type_modified';
  } else {
    return {
      result: {
        status: 'rejected',
        type: typeName,
        reason: 'Invalid proposal: missing edit definition for the specified proposal type',
      },
    };
  }

  const changeRecord: VocabularyChangeRecord = {
    changeId: generateChangeId(),
    changeType,
    typeName,
    previousVersion: vocabulary.version,
    newVersion,
    proposedBy,
    proposedAt: now,
    approvedAt: now,
    reason: proposal.justification,
  };

  return {
    result: { status: 'approved', type: typeName, vocabularyVersion: newVersion },
    updatedVocabulary,
    changeRecord,
  };
}

/** Apply a delete proposal to the vocabulary (vocabulary only — data cascade is handled by VocabularyEngine) */
function applyDeleteProposal(
  vocabulary: MemoryVocabulary,
  proposal: VocabularyProposal,
  proposedBy: string,
): {
  result: VocabularyProposalResult;
  updatedVocabulary?: MemoryVocabulary;
  changeRecord?: VocabularyChangeRecord;
} {
  const now = new Date().toISOString();
  const typeName = getProposedTypeName(proposal);
  const newVersion = incrementVersion(vocabulary.version, 'major');

  let updatedVocabulary: MemoryVocabulary;
  let changeType: VocabularyChangeRecord['changeType'];

  if (proposal.proposalType === 'delete_entity_type' && proposal.deleteEntityType) {
    const exists = vocabulary.entityTypes.some((et) => et.type === proposal.deleteEntityType!.type);
    if (!exists) {
      return {
        result: {
          status: 'rejected',
          type: typeName,
          reason: `Entity type "${typeName}" not found in vocabulary`,
        },
      };
    }
    updatedVocabulary = {
      ...vocabulary,
      version: newVersion,
      lastModified: now,
      modifiedBy: proposedBy,
      entityTypes: vocabulary.entityTypes.filter((et) => et.type !== typeName),
    };
    changeType = 'entity_type_removed';
  } else if (
    proposal.proposalType === 'delete_relationship_type' &&
    proposal.deleteRelationshipType
  ) {
    const exists = vocabulary.relationshipTypes.some(
      (rt) => rt.type === proposal.deleteRelationshipType!.type,
    );
    if (!exists) {
      return {
        result: {
          status: 'rejected',
          type: typeName,
          reason: `Relationship type "${typeName}" not found in vocabulary`,
        },
      };
    }
    updatedVocabulary = {
      ...vocabulary,
      version: newVersion,
      lastModified: now,
      modifiedBy: proposedBy,
      relationshipTypes: vocabulary.relationshipTypes.filter((rt) => rt.type !== typeName),
    };
    changeType = 'relationship_type_removed';
  } else {
    return {
      result: {
        status: 'rejected',
        type: typeName,
        reason: 'Invalid proposal: missing delete definition for the specified proposal type',
      },
    };
  }

  const changeRecord: VocabularyChangeRecord = {
    changeId: generateChangeId(),
    changeType,
    typeName,
    previousVersion: vocabulary.version,
    newVersion,
    proposedBy,
    proposedAt: now,
    approvedAt: now,
    reason: proposal.justification,
  };

  return {
    result: { status: 'approved', type: typeName, vocabularyVersion: newVersion },
    updatedVocabulary,
    changeRecord,
  };
}

function getProposedTypeName(proposal: VocabularyProposal): string {
  switch (proposal.proposalType) {
    case 'entity_type':
      return proposal.entityType?.type ?? 'unknown';
    case 'relationship_type':
      return proposal.relationshipType?.type ?? 'unknown';
    case 'edit_entity_type':
      return proposal.editEntityType?.type ?? 'unknown';
    case 'edit_relationship_type':
      return proposal.editRelationshipType?.type ?? 'unknown';
    case 'delete_entity_type':
      return proposal.deleteEntityType?.type ?? 'unknown';
    case 'delete_relationship_type':
      return proposal.deleteRelationshipType?.type ?? 'unknown';
  }
}

function generateProposalId(): string {
  return `proposal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateChangeId(): string {
  return `change_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
