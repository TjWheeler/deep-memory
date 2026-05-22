/**
 * Domain Knowledge — pre-built vocabulary for a legal document analysis system.
 *
 * This example shows:
 * - Defining a rich domain vocabulary with property schemas
 * - Using governance modes to control vocabulary evolution
 * - Working with typed properties and validation
 * - Proposing vocabulary extensions at runtime
 */

import {
  DeepMemory,
  InMemoryStorageProvider,
  type VocabularyProposal,
} from '@utaba/deep-memory';

async function main() {
  const memory = new DeepMemory({
    storage: new InMemoryStorageProvider(),
    provenance: { actorId: 'legal-analyst', actorType: 'agent' },
  });

  // Define a legal domain vocabulary with property schemas
  const repo = await memory.createRepository({
    repositoryId: 'legal-analysis',
    label: 'Legal Document Analysis',
    vocabulary: {
      entityTypes: [
        {
          type: 'contract',
          description: 'A legal contract or agreement between parties',
          properties: [
            { name: 'contract_type', type: 'enum', required: true, enumValues: ['service', 'employment', 'nda', 'license', 'other'] },
            { name: 'effective_date', type: 'date', required: true, description: 'When the contract takes effect' },
            { name: 'expiry_date', type: 'date', required: false, description: 'When the contract expires' },
            { name: 'value', type: 'number', required: false, description: 'Total contract value in USD' },
          ],
        },
        {
          type: 'clause',
          description: 'A specific clause or provision within a contract',
          properties: [
            { name: 'clause_number', type: 'string', required: true },
            { name: 'risk_level', type: 'enum', required: false, enumValues: ['low', 'medium', 'high', 'critical'] },
          ],
        },
        {
          type: 'party',
          description: 'A legal entity (person or organization) that is a party to a contract',
          properties: [
            { name: 'party_type', type: 'enum', required: true, enumValues: ['individual', 'corporation', 'llc', 'partnership', 'government'] },
            { name: 'jurisdiction', type: 'string', required: false },
          ],
        },
        {
          type: 'obligation',
          description: 'A specific obligation or requirement arising from a contract',
          properties: [
            { name: 'deadline', type: 'date', required: false },
            { name: 'status', type: 'enum', required: true, enumValues: ['pending', 'in_progress', 'completed', 'overdue'], defaultValue: 'pending' },
          ],
        },
      ],
      relationshipTypes: [
        {
          type: 'party_to',
          description: 'A party is a signatory to a contract',
          allowedSourceTypes: ['party'],
          allowedTargetTypes: ['contract'],
          properties: [
            { name: 'role', type: 'enum', required: true, enumValues: ['buyer', 'seller', 'licensor', 'licensee', 'employer', 'employee', 'other'] },
          ],
        },
        {
          type: 'contains_clause',
          description: 'A contract contains a specific clause',
          allowedSourceTypes: ['contract'],
          allowedTargetTypes: ['clause'],
        },
        {
          type: 'creates_obligation',
          description: 'A clause creates a specific obligation',
          allowedSourceTypes: ['clause'],
          allowedTargetTypes: ['obligation'],
        },
        {
          type: 'obligated_party',
          description: 'A party is responsible for fulfilling an obligation',
          allowedSourceTypes: ['obligation'],
          allowedTargetTypes: ['party'],
        },
      ],
    },
    // Managed governance: proposals are validated but auto-approved (no human gate)
    governance: { mode: 'managed', requireApproval: false },
  });

  // Create entities with typed properties (validated against vocabulary)
  console.log('Creating contract entities...');

  const [acmeCorp] = await repo.createEntities([{
    entityType: 'party',
    label: 'Acme Corporation',
    summary: 'Technology services company',
    properties: {
      party_type: 'corporation',
      jurisdiction: 'Delaware, USA',
    },
  }]);

  const [widgetInc] = await repo.createEntities([{
    entityType: 'party',
    label: 'Widget Inc',
    summary: 'Widget manufacturing company',
    properties: {
      party_type: 'corporation',
      jurisdiction: 'California, USA',
    },
  }]);

  const [serviceContract] = await repo.createEntities([{
    entityType: 'contract',
    label: 'Acme-Widget Service Agreement',
    summary: 'Annual technology services agreement',
    properties: {
      contract_type: 'service',
      effective_date: '2024-01-01',
      expiry_date: '2024-12-31',
      value: 250000,
    },
  }]);

  const [indemnityClause] = await repo.createEntities([{
    entityType: 'clause',
    label: 'Indemnification Clause',
    summary: 'Mutual indemnification for third-party claims',
    properties: {
      clause_number: '7.1',
      risk_level: 'high',
    },
    data: 'Each party shall indemnify, defend, and hold harmless the other party...',
    dataFormat: 'text/plain',
  }]);

  const [deliveryObligation] = await repo.createEntities([{
    entityType: 'obligation',
    label: 'Monthly Report Delivery',
    summary: 'Acme must deliver monthly service reports by the 5th',
    properties: {
      deadline: '2024-02-05',
      status: 'pending',
    },
  }]);

  // Create relationships
  await repo.createRelationships([{
    relationshipType: 'party_to',
    sourceEntityId: acmeCorp.entityId,
    targetEntityId: serviceContract.entityId,
    properties: { role: 'seller' },
  }]);

  await repo.createRelationships([{
    relationshipType: 'party_to',
    sourceEntityId: widgetInc.entityId,
    targetEntityId: serviceContract.entityId,
    properties: { role: 'buyer' },
  }]);

  await repo.createRelationships([{
    relationshipType: 'contains_clause',
    sourceEntityId: serviceContract.entityId,
    targetEntityId: indemnityClause.entityId,
  }]);

  await repo.createRelationships([{
    relationshipType: 'creates_obligation',
    sourceEntityId: indemnityClause.entityId,
    targetEntityId: deliveryObligation.entityId,
  }]);

  await repo.createRelationships([{
    relationshipType: 'obligated_party',
    sourceEntityId: deliveryObligation.entityId,
    targetEntityId: acmeCorp.entityId,
  }]);

  // Demonstrate vocabulary extension at runtime
  console.log('\nProposing vocabulary extension...');

  const proposal: VocabularyProposal = {
    proposalType: 'entity_type',
    entityType: {
      type: 'amendment',
      description: 'A formal modification to an existing contract',
      properties: [
        { name: 'amendment_date', type: 'date', required: true },
        { name: 'amendment_number', type: 'number', required: true },
      ],
    },
    justification: 'Need to track contract amendments discovered during analysis',
  };

  const result = await repo.proposeVocabularyExtension(proposal);
  console.log(`  Proposal status: ${result.status}`);

  if (result.status === 'approved') {
    // Now we can create amendment entities
    await repo.createEntities([{
      entityType: 'amendment',
      label: 'Amendment #1 - Payment Terms',
      summary: 'Revised payment schedule from net-30 to net-45',
      properties: {
        amendment_date: '2024-06-15',
        amendment_number: 1,
      },
    }]);
    console.log('  Created amendment entity with new type');
  }

  // Show final stats
  const stats = await repo.getStats();
  console.log(`\nFinal stats: ${stats.entityCount} entities, ${stats.relationshipCount} relationships`);
  console.log(`Vocabulary: ${stats.vocabularyVersion}`);

  await memory.dispose();
}

main().catch(console.error);
