// Provenance — automatic traceability on all mutations

/** Context provided by the consumer to identify who is performing operations */
export interface ProvenanceContext {
  /** User or agent ID performing the operation */
  actorId: string;
  /** Whether the actor is a human user or an AI agent */
  actorType: 'user' | 'agent';
  /** Optional conversation ID — links memory to a conversation */
  conversationId?: string;
  /** Optional message ID — links memory to a specific message */
  messageId?: string;
}

/** Full provenance record stored on every entity and relationship */
export interface Provenance {
  createdBy: string;
  createdByType: 'user' | 'agent';
  createdAt: string; // ISO 8601
  createdInConversation?: string;
  createdFromMessage?: string;
  modifiedBy: string;
  modifiedByType: 'user' | 'agent';
  modifiedAt: string; // ISO 8601
  modifiedInConversation?: string;
  modifiedFromMessage?: string;
}
