// Vocabulary — the domain grammar for a memory repository

/** Property type for vocabulary property schemas */
export type PropertyType = 'string' | 'number' | 'boolean' | 'date' | 'enum';

/** Defines a property on an entity or relationship type */
export interface PropertySchema {
  name: string;
  type: PropertyType;
  required: boolean;
  description?: string;
  /** Valid values when type === "enum" */
  enumValues?: string[];
  defaultValue?: unknown;
  /** When true, this property's value is appended to the entity's embedding text. Only valid for string properties. Omitted when false or not applicable — never serialized as false. */
  embeddable?: true;
}

/** Definition of an entity type within a vocabulary */
export interface EntityTypeDefinition {
  /** Type identifier, e.g., "clause", "part", "person" */
  type: string;
  /** Natural language description — critical for AI comprehension */
  description: string;
  /** Version of this type definition */
  version: string;
  /** Expected properties and their types */
  properties: PropertySchema[];
  createdAt: string;
  createdBy: string;
  modifiedAt: string;
  modifiedBy: string;
}

/** Definition of a relationship type within a vocabulary */
export interface RelationshipTypeDefinition {
  /** Type identifier, e.g., "requires_clause", "component_of" */
  type: string;
  /** Natural language description */
  description: string;
  /** Version of this type definition */
  version: string;
  /** Valid source entity types */
  allowedSourceTypes: string[];
  /** Valid target entity types */
  allowedTargetTypes: string[];
  /** Whether the relationship is symmetric */
  bidirectional: boolean;
  /** Optional edge properties */
  properties?: PropertySchema[];
  createdAt: string;
  createdBy: string;
  modifiedAt: string;
  modifiedBy: string;
}

/** The vocabulary schema of a memory repository */
export interface MemoryVocabulary {
  /** Semantic version of the vocabulary */
  version: string;
  /** ISO timestamp of last modification */
  lastModified: string;
  /** User or system that last modified the vocabulary */
  modifiedBy: string;
  entityTypes: EntityTypeDefinition[];
  relationshipTypes: RelationshipTypeDefinition[];
}

/** Vocabulary governance mode — controls how the vocabulary can evolve */
export type GovernanceMode = 'locked' | 'managed' | 'open';

/** Governance configuration for a repository */
export interface GovernanceConfig {
  mode: GovernanceMode;
  /** Managed mode: similarity score below which proposals auto-approve (default 0.3) */
  autoApproveThreshold?: number;
  /** Managed mode: if true, all proposals queue for human approval regardless of checks */
  requireApproval?: boolean;
  /** Open mode: whether deduplication is still enforced (default true) */
  deduplicationEnabled?: boolean;
  /** Default similarity threshold for semantic search (0.0-1.0, default 0.5). Model-dependent — lower for local models, higher for OpenAI. */
  defaultSimilarityThreshold?: number;
}

/** Proposal to change the vocabulary — add, edit, or delete a type */
export interface VocabularyProposal {
  proposalType:
    | 'entity_type'
    | 'relationship_type'
    | 'edit_entity_type'
    | 'edit_relationship_type'
    | 'delete_entity_type'
    | 'delete_relationship_type';
  /** Used when proposalType is 'entity_type' (add new) */
  entityType?: {
    type: string;
    description: string;
    properties?: PropertySchema[];
  };
  /** Used when proposalType is 'relationship_type' (add new) */
  relationshipType?: {
    type: string;
    description: string;
    allowedSourceTypes: string[];
    allowedTargetTypes: string[];
    bidirectional?: boolean;
    properties?: PropertySchema[];
  };
  /** Used when proposalType is 'edit_entity_type' */
  editEntityType?: {
    type: string;
    description?: string;
    addProperties?: PropertySchema[];
    removeProperties?: string[];
    updateProperties?: PropertySchema[];
  };
  /** Used when proposalType is 'edit_relationship_type' */
  editRelationshipType?: {
    type: string;
    description?: string;
    allowedSourceTypes?: string[];
    allowedTargetTypes?: string[];
    bidirectional?: boolean;
    addProperties?: PropertySchema[];
    removeProperties?: string[];
    updateProperties?: PropertySchema[];
  };
  /** Used when proposalType is 'delete_entity_type' */
  deleteEntityType?: { type: string };
  /** Used when proposalType is 'delete_relationship_type' */
  deleteRelationshipType?: { type: string };
  /** Why this change is needed */
  justification: string;
}

/** Result of a vocabulary change proposal */
export interface VocabularyProposalResult {
  status: 'approved' | 'pending_approval' | 'rejected';
  proposalId?: string;
  /** The type name that was proposed */
  type: string;
  /** New vocabulary version if approved */
  vocabularyVersion?: string;
  /** Reason for rejection */
  reason?: string;
  /** Similar existing types if rejected as duplicate */
  duplicates?: Array<{ type: string; description: string; similarity: number }>;
  /** Number of entities cascade-deleted (delete_entity_type only) */
  cascadedEntities?: number;
  /** Number of relationships cascade-deleted (delete operations) */
  cascadedRelationships?: number;
}

/** Record of a vocabulary change for auditing */
export interface VocabularyChangeRecord {
  changeId: string;
  changeType:
    | 'entity_type_added'
    | 'relationship_type_added'
    | 'entity_type_modified'
    | 'relationship_type_modified'
    | 'entity_type_removed'
    | 'relationship_type_removed';
  typeName: string;
  previousVersion?: string;
  newVersion: string;
  proposedBy: string;
  proposedAt: string;
  approvedBy?: string;
  approvedAt?: string;
  reason: string;
}

/** Vocabulary with resolved governance info and stats */
export interface ResolvedVocabulary {
  vocabulary: MemoryVocabulary;
  governanceMode: GovernanceMode;
  governanceConfig: GovernanceConfig;
}

/** Input for creating entity type definitions (without system-managed fields) */
export interface EntityTypeInput {
  type: string;
  description: string;
  properties?: PropertySchema[];
}

/** Input for creating relationship type definitions (without system-managed fields) */
export interface RelationshipTypeInput {
  type: string;
  description: string;
  allowedSourceTypes: string[];
  allowedTargetTypes: string[];
  bidirectional?: boolean;
  properties?: PropertySchema[];
}

/** Input vocabulary definition used when creating a repository */
export interface VocabularyInput {
  entityTypes?: EntityTypeInput[];
  relationshipTypes?: RelationshipTypeInput[];
}
