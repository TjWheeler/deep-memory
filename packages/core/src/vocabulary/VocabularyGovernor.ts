// VocabularyGovernor — implements governance modes for vocabulary evolution

import type {
  GovernanceConfig,
  MemoryVocabulary,
  RelationshipTypeDefinition,
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
import { toScreamingSnakeCase } from './similarity.js';

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

/** What governance made of a proposal */
export interface ProposalOutcome {
  result: VocabularyProposalResult;
  /** The vocabulary to store, when the proposal is approved */
  updatedVocabulary?: MemoryVocabulary;
  /** The audit record to store with `updatedVocabulary`, when the proposal is approved */
  changeRecord?: VocabularyChangeRecord;
  /**
   * `true` only on the "not found" rejection of a `delete_entity_type` or
   * `delete_relationship_type` proposal whose type the vocabulary does not
   * declare. A type deletion stores the vocabulary first and deletes the
   * type's data afterwards, so an absent type may still have data left by a
   * deletion whose data step failed; this flag lets the caller resume that
   * step instead of treating the rejection as final.
   */
  typeAbsent?: true;
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
): ProposalOutcome {
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

/**
 * Apply an add proposal to the vocabulary.
 *
 * A relationship type is stored under its SCREAMING_SNAKE_CASE name, so the
 * result and the change record carry that name rather than the one proposed:
 * it is the name later edits, deletes and data refer to.
 */
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
  let typeName = getProposedTypeName(proposal);

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
    typeName = newType.type;
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

/**
 * Apply an edit proposal to the vocabulary.
 *
 * A relationship type is matched by the name as proposed, or failing that by
 * its SCREAMING_SNAKE_CASE form (the form relationship types are stored in),
 * so `works_on` edits `WORKS_ON`. The stored type keeps its name, and the
 * result and the change record carry that stored name.
 */
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
  let typeName = getProposedTypeName(proposal);
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
    const normalised = toScreamingSnakeCase(typeName);
    const existing = findRelationshipType(vocabulary, typeName);
    if (!existing) {
      return {
        result: {
          status: 'rejected',
          type: normalised,
          reason: `Relationship type "${normalised}" not found in vocabulary`,
        },
      };
    }
    typeName = existing.type;
    const merged = mergeRelationshipTypeEdit(existing, proposal.editRelationshipType, proposedBy);
    updatedVocabulary = {
      ...vocabulary,
      version: newVersion,
      lastModified: now,
      modifiedBy: proposedBy,
      relationshipTypes: vocabulary.relationshipTypes.map((rt) =>
        rt === existing ? merged : rt,
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

/**
 * Apply a delete proposal to the vocabulary (vocabulary only — data cascade is
 * handled by VocabularyEngine).
 *
 * A relationship type is matched the same way an edit matches it: by the
 * name as proposed, or failing that by its SCREAMING_SNAKE_CASE form, so
 * `works_on` deletes `WORKS_ON`. The exact match comes first because the
 * conversion is not idempotent (`HAS_A1B` converts to `HAS_A1_B`), so a
 * declared name is not always reachable through its converted form. The
 * result's `type` is the declared name that matched; when nothing matched it
 * is the SCREAMING_SNAKE_CASE form, the name new data is stored under.
 */
function applyDeleteProposal(
  vocabulary: MemoryVocabulary,
  proposal: VocabularyProposal,
  proposedBy: string,
): ProposalOutcome {
  const now = new Date().toISOString();
  const typeName =
    proposal.proposalType === 'delete_relationship_type' && proposal.deleteRelationshipType
      ? (findRelationshipType(vocabulary, proposal.deleteRelationshipType.type)?.type ??
        toScreamingSnakeCase(proposal.deleteRelationshipType.type))
      : getProposedTypeName(proposal);
  const newVersion = incrementVersion(vocabulary.version, 'major');

  let updatedVocabulary: MemoryVocabulary;
  let changeType: VocabularyChangeRecord['changeType'];

  if (proposal.proposalType === 'delete_entity_type' && proposal.deleteEntityType) {
    const exists = vocabulary.entityTypes.some((et) => et.type === typeName);
    if (!exists) {
      return {
        result: {
          status: 'rejected',
          type: typeName,
          reason: `Entity type "${typeName}" not found in vocabulary`,
        },
        typeAbsent: true,
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
    const exists = vocabulary.relationshipTypes.some((rt) => rt.type === typeName);
    if (!exists) {
      return {
        result: {
          status: 'rejected',
          type: typeName,
          reason: `Relationship type "${typeName}" not found in vocabulary`,
        },
        typeAbsent: true,
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

/**
 * The relationship type `vocabulary` declares under `name` exactly, or
 * failing that under `name`'s SCREAMING_SNAKE_CASE form.
 */
function findRelationshipType(
  vocabulary: MemoryVocabulary,
  name: string,
): RelationshipTypeDefinition | undefined {
  const normalised = toScreamingSnakeCase(name);
  return (
    vocabulary.relationshipTypes.find((rt) => rt.type === name) ??
    vocabulary.relationshipTypes.find((rt) => rt.type === normalised)
  );
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
