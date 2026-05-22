/**
 * Personal Memory — build a personal knowledge graph for an AI assistant.
 *
 * This example shows:
 * - Creating a DeepMemory instance with InMemoryStorageProvider
 * - Defining a vocabulary for personal knowledge
 * - Creating entities and relationships
 * - Querying the graph (find, explore, paths)
 * - Listening to events
 */

import {
  DeepMemory,
  InMemoryStorageProvider,
} from '@utaba/deep-memory';

async function main() {
  // 1. Create a DeepMemory instance
  const memory = new DeepMemory({
    storage: new InMemoryStorageProvider(),
    provenance: {
      actorId: 'personal-assistant',
      actorType: 'agent',
      conversationId: 'conv-001',
    },
  });

  // 2. Create a repository with a vocabulary
  const repo = await memory.createRepository({
    repositoryId: 'personal',
    label: 'Personal Knowledge',
    description: 'Things I know about the user and their world',
    vocabulary: {
      entityTypes: [
        { type: 'person', description: 'A person the user knows or has mentioned' },
        { type: 'project', description: 'A project the user is working on' },
        { type: 'topic', description: 'A topic or area of interest' },
        { type: 'preference', description: 'A user preference or opinion' },
      ],
      relationshipTypes: [
        {
          type: 'works_on',
          description: 'A person works on a project',
          allowedSourceTypes: ['person'],
          allowedTargetTypes: ['project'],
        },
        {
          type: 'interested_in',
          description: 'A person is interested in a topic',
          allowedSourceTypes: ['person'],
          allowedTargetTypes: ['topic'],
        },
        {
          type: 'relates_to',
          description: 'A topic relates to another topic',
          allowedSourceTypes: ['topic'],
          allowedTargetTypes: ['topic'],
          bidirectional: true,
        },
        {
          type: 'collaborates_with',
          description: 'Two people work together',
          allowedSourceTypes: ['person'],
          allowedTargetTypes: ['person'],
          bidirectional: true,
        },
      ],
    },
    governance: { mode: 'open' },
  });

  // 3. Listen to events
  repo.on('entity:created', (event) => {
    console.log(`  [event] Created: ${event.payload.entity.label}`);
  });

  // 4. Populate with knowledge
  console.log('Creating entities...');

  const [user] = await repo.createEntities([{
    entityType: 'person',
    label: 'John Smith',
    summary: 'The user.',
  }]);

  const [sarah] = await repo.createEntities([{
    entityType: 'person',
    label: 'Sarah Chen',
    summary: 'CTO at Example App. Expert in distributed systems.',
  }]);

  const [deepMemory] = await repo.createEntities([{
    entityType: 'project',
    label: 'Deep Memory',
    summary: 'Vocabulary-driven graph memory library for AI agents.',
  }]);

  const [exampleApp] = await repo.createEntities([{
    entityType: 'project',
    label: 'Example App',
    summary: 'A consumer application using Deep Memory for AI agent memory.',
  }]);

  const [graphDatabases] = await repo.createEntities([{
    entityType: 'topic',
    label: 'Graph Databases',
    summary: 'Knowledge graph storage and querying.',
  }]);

  const [aiAgents] = await repo.createEntities([{
    entityType: 'topic',
    label: 'AI Agents',
    summary: 'Autonomous AI systems with tool use and memory.',
  }]);

  // 5. Create relationships
  console.log('\nCreating relationships...');

  await repo.createRelationships([{
    relationshipType: 'works_on',
    sourceEntityId: user.entityId,
    targetEntityId: deepMemory.entityId,
  }]);

  await repo.createRelationships([{
    relationshipType: 'works_on',
    sourceEntityId: user.entityId,
    targetEntityId: exampleApp.entityId,
  }]);

  await repo.createRelationships([{
    relationshipType: 'works_on',
    sourceEntityId: sarah.entityId,
    targetEntityId: exampleApp.entityId,
  }]);

  await repo.createRelationships([{
    relationshipType: 'collaborates_with',
    sourceEntityId: user.entityId,
    targetEntityId: sarah.entityId,
  }]);

  await repo.createRelationships([{
    relationshipType: 'interested_in',
    sourceEntityId: user.entityId,
    targetEntityId: graphDatabases.entityId,
  }]);

  await repo.createRelationships([{
    relationshipType: 'interested_in',
    sourceEntityId: user.entityId,
    targetEntityId: aiAgents.entityId,
  }]);

  await repo.createRelationships([{
    relationshipType: 'relates_to',
    sourceEntityId: graphDatabases.entityId,
    targetEntityId: aiAgents.entityId,
  }]);

  // 6. Query the graph
  console.log('\n--- Queries ---');

  // Find entities
  const people = await repo.findEntities({ entityTypes: ['person'] });
  console.log(`\nPeople: ${people.items.map((p) => p.label).join(', ')}`);

  // Explore Tim's neighborhood
  const neighborhood = await repo.exploreNeighborhood(user.entityId, { depth: 1 });
  console.log(`\nTim's connections (depth 1):`);
  for (const layer of neighborhood.layers) {
    for (const [relType, group] of Object.entries(layer)) {
      console.log(`  ${relType}: ${group.entities.map((e) => e.label).join(', ')}`);
    }
  }

  // Find path from Sarah to Graph Databases
  const paths = await repo.findPaths(sarah.entityId, graphDatabases.entityId);
  console.log(`\nPaths from Sarah to Graph Databases: ${paths.totalPaths}`);
  for (const path of paths.paths) {
    const route = path.entities.map((e) => e.label).join(' → ');
    console.log(`  ${route}`);
  }

  // 7. Repository stats
  const stats = await repo.getStats();
  console.log(`\nRepository stats:`);
  console.log(`  Entities: ${stats.entityCount}`);
  console.log(`  Relationships: ${stats.relationshipCount}`);
  console.log(`  Types: ${JSON.stringify(stats.entityTypeBreakdown)}`);

  // 8. Export the repository
  const archive = await memory.exportRepository('personal');
  console.log(`\nExported: ${archive.entities.length} entities, ${archive.relationships.length} relationships`);

  await memory.dispose();
  console.log('\nDone.');
}

main().catch(console.error);
