// Neo4j schema for @utaba/deep-memory StorageProvider
//
// Label and property conventions (per D4–D7 of plans/neo4j-provider.md):
//   System labels:   _Entity, _Repository, _Vocabulary, _VocabularyChangeLog, _Meta
//   Entity nodes:    :_Entity:<EntityType> — umbrella label drives one constraint /
//                    one fulltext index across every entity type.
//   Multi-tenancy:   every node and relationship carries a `repositoryId` property;
//                    every composite constraint / index leads with `repositoryId`.
//
// All statements are valid Cypher 25. Each statement runs as its own round-trip
// because Neo4j parses one statement per `executeQuery` / `tx.run` call.

export const SCHEMA_VERSION = 1;

/**
 * Returns the constraint / index DDL for the deep-memory Neo4j schema as an
 * array of single statements. Each statement is idempotent via
 * `IF NOT EXISTS`. Callers (the provider's `ensureSchema`, or operators
 * running out-of-band against a managed Neo4j) execute the statements one by
 * one.
 *
 * Composite uniqueness and lookup indexes all lead with `repositoryId` so the
 * planner uses it as the cheap discriminator — see D3b layer 1 in the plan.
 * The fulltext index is unfiltered; callers that query it must add an
 * explicit `WHERE node.repositoryId = $rid` post-filter.
 */
export function getSchemaCypher(): readonly string[] {
  return [
    // Composite node-property uniqueness on (repositoryId, id) — the load-bearing
    // primary discriminator for every entity-scoped query.
    `CREATE CONSTRAINT dm_entity_unique IF NOT EXISTS
FOR (n:_Entity) REQUIRE (n.repositoryId, n.id) IS UNIQUE`,

    // Composite uniqueness on (repositoryId, slug) — backs getEntityBySlug
    // and guarantees stable URL-style addressing within a repository.
    `CREATE CONSTRAINT dm_entity_slug_unique IF NOT EXISTS
FOR (n:_Entity) REQUIRE (n.repositoryId, n.slug) IS UNIQUE`,

    // Repository uniqueness — backs getRepository and listRepositories.
    `CREATE CONSTRAINT dm_repository_unique IF NOT EXISTS
FOR (n:_Repository) REQUIRE n.repositoryId IS UNIQUE`,

    // Range index (default for `CREATE INDEX` without a type keyword) covering
    // (repositoryId, entityType) — backs findEntities type-filter and
    // deleteEntitiesByType.
    `CREATE INDEX dm_entity_type_lookup IF NOT EXISTS
FOR (n:_Entity) ON (n.repositoryId, n.entityType)`,

    // Range index on (repositoryId, modifiedAt) — backs timeline and recency
    // ordering. Date is stored as ISO-8601 string (D6), lexicographic order
    // matches chronological order.
    `CREATE INDEX dm_entity_modified IF NOT EXISTS
FOR (n:_Entity) ON (n.repositoryId, n.modifiedAt)`,

    // Fulltext index on entity label + summary — backs the findEntities
    // searchTerm branch via CALL db.index.fulltext.queryNodes(...). Unfiltered
    // by design; query callers must post-filter by repositoryId (see D3b).
    `CREATE FULLTEXT INDEX dm_entity_text IF NOT EXISTS
FOR (n:_Entity) ON EACH [n.label, n.summary]`,
  ];
}
