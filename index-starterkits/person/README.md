# Person Domain Starter Kit

## Purpose

This starter kit defines a vocabulary and indexing process for building knowledge graphs about **people and their relationships**. It covers identity, social connections, life events, organizational roles, and contact information.

## Target Use Cases

- **Contact networks** -- who knows whom, professional and personal connections
- **Family and genealogy** -- parents, siblings, spouses, children
- **Team directories** -- people, their roles, the organizations they belong to
- **Biographical timelines** -- key life events anchored to dates and locations

## What the Graph Can Answer

Once populated, an agent can answer questions like:

- "Who does Alice know at Contoso?"
- "Where was Bob born and where does he live now?"
- "Show me everyone who works at Acme Corp in the engineering department."
- "How are Alice and Charlie connected?" (path finding)
- "What life events happened for this person in 2024?"

## When to Use This Kit

Use this starter kit when:

- The primary subject matter is **people** and their connections to each other, organizations, and places.
- You need a general-purpose person model. For highly specialized domains (e.g. medical patient records, legal case parties), consider extending this vocabulary or building a domain-specific kit.

## Governance Recommendation

**`open`** governance is recommended for most person-graph use cases. This allows the agent to auto-extend the vocabulary when it encounters edge cases (e.g. a new relationship type like `MENTORS`) without blocking the indexing flow. Switch to **`managed`** if you need human approval on vocabulary changes.

## Starter Kit Files

- **`vocabulary.md`** -- Entity and relationship type definitions for the person domain.
- **`domain-guidance.md`** -- Extraction prompt guidance for AI agents performing automated indexing.
- **`README.md`** -- This file. Overview, starter kit contents, and indexing guidance.

## Automated Extraction

The `vocabulary.md` and `domain-guidance.md` files are consumed by the indexing pipeline automatically. When configuring an indexing session, point the pipeline at this starter kit directory and it will load the vocabulary and domain guidance without manual intervention.

For full configuration details, see [docs/indexer-extraction-guide.md](../../docs/indexer-extraction-guide.md).

## Manual Indexing Process (MCP Tools)

Step-by-step guidance for an AI agent indexing person-related data into a deep-memory repository using MCP tools directly.

---

### Prerequisites

- Read `vocabulary.md` in this folder to understand the available entity types and relationship types.
- Ensure the MCP server is running and accessible.

---

### Step 1 -- Create or Open the Repository

If a person-domain repository already exists, open it. Otherwise, create one.

When creating:
- Choose a descriptive `label` (e.g. "Acme Corp Team Directory").
- The `repositoryId` must be a valid UUID (e.g. `a1b2c3d4-e5f6-7890-abcd-ef1234567890`). If omitted, one is auto-generated.
- Set governance mode to `open` unless the user requests stricter control.
- Include the full vocabulary from `vocabulary.md`: all four entity types (`Person`, `Organization`, `Location`, `Event`) and all relationship types.

After creating, verify by listing repositories or getting stats.

---

### Step 2 -- Index Entities (Nodes First)

**Always create entities before the relationships that reference them.**

Follow this order to avoid dangling references:

1. **Locations** -- Create any locations that will be referenced (cities, countries, addresses). These are the most reusable entities and are often shared across people.

2. **Organizations** -- Create organizations that people belong to, work at, studied at, or are members of. Link them to locations with `LOCATED_IN` immediately if the location is known.

3. **People** -- Create person entities. Use the label convention `{firstName} {lastName}`. Populate all known properties. Write a concise summary that captures role and context.

4. **Events** -- Create life events last, since they often reference people and locations.

#### Deduplication

Before creating any entity, check if it already exists:
- Use `find_entities` with a search term matching the label.
- Entity IDs are GUIDs, but each entity also has a deterministic `slug` (`{type}:{slugified-label}`). You can use `find_entities` or look up by slug with `get_entity`.

If an entity already exists, use `update_entity` to merge new information rather than creating a duplicate.

---

### Step 3 -- Index Relationships (Edges)

After all entities exist, create the relationships:

1. **Location relationships** -- `BORN_IN`, `LIVES_IN` (include `startDate`/`endDate` for temporal accuracy), `LOCATED_IN`
2. **Education relationships** -- `STUDIED_AT` (include `qualification`, `field`, and dates where known)
3. **Professional relationships** -- `WORKS_AT` (include `role`, `department`, dates), `MANAGES` (include dates), `FOUNDED`, `MEMBER_OF` (include `role` and dates)
4. **Social relationships** -- `KNOWS` (include `context` to capture how they know each other), `IS_FRIENDS_WITH` (include `context`), `IS_RELATED_TO` (always include `relation`), `IS_MARRIED_TO` (include `marriageDate`), `IS_PARENT_OF`
5. **Event relationships** -- `EXPERIENCED`, `OCCURRED_AT`, `INVOLVED_IN`

#### Relationship Tips

- For bidirectional types (`KNOWS`, `IS_FRIENDS_WITH`, etc.), create the relationship once only. The graph handles both directions.
- Include properties where applicable -- properties are what make relationships queryable and useful. A `KNOWS` relationship with `context: "met at PyCon 2024"` is far more valuable than one without.
- For temporal relationships (`WORKS_AT`, `LIVES_IN`, `MANAGES`, `MEMBER_OF`, `STUDIED_AT`), always include `startDate` when known. Omit `endDate` to indicate the relationship is current.
- If the source or target entity doesn't exist yet, create it first -- don't skip the relationship.

---

### Step 4 -- Verify the Graph

After indexing, verify the data is correct:

1. **Get stats** -- Check entity and relationship counts match expectations.
2. **Spot-check entities** -- Retrieve a few key entities with `get_entity` at `full` detail level.
3. **Test traversal** -- Use `explore_neighborhood` on a central person (depth 2) to confirm the graph is well-connected.
4. **Test path finding** -- Pick two people who should be connected and use `find_paths` to verify.

---

### Step 5 -- Ongoing Maintenance

As new information arrives:

- **New people or connections** -- Follow Steps 2-3 for new data. Always deduplicate first.
- **Updates** -- Use `update_entity` to revise properties, summaries, or data. Provenance is tracked automatically.
- **Temporal transitions** -- When a relationship changes (e.g. someone leaves a job, moves city), set `endDate` on the existing relationship and create a new one for the current state. This preserves history.
- **Removals** -- Use `delete_entity` (cascades to relationships) or `remove_relationship` for individual edges.
- **Vocabulary gaps** -- If you encounter a relationship or entity type not in the vocabulary, use `propose_vocabulary_extension` to add it. In `open` mode this is auto-approved.

---

### Example Indexing Sequence

Given: "Alice Johnson is a software engineer at Acme Corp in London. She studied Computer Science at Imperial College London. She knows Bob Smith -- they met at PyCon 2023. Bob is a product manager at the same company. Alice has lived in London since 2019."

1. Create Location: "London, UK" (locationType: city, country: UK)
2. Create Organization: "Acme Corp" (orgType: company)
3. Create Organization: "Imperial College London" (orgType: university)
4. Create relationship: Acme Corp `LOCATED_IN` London, UK
5. Create relationship: Imperial College London `LOCATED_IN` London, UK
6. Create Person: "Alice Johnson" (summary: "Software engineer at Acme Corp, London")
7. Create Person: "Bob Smith" (summary: "Product manager at Acme Corp, London")
8. Create relationship: Alice `WORKS_AT` Acme Corp (role: software engineer)
9. Create relationship: Bob `WORKS_AT` Acme Corp (role: product manager)
10. Create relationship: Alice `STUDIED_AT` Imperial College London (field: Computer Science)
11. Create relationship: Alice `LIVES_IN` London, UK (startDate: 2019-01-01)
12. Create relationship: Alice `KNOWS` Bob (context: "met at PyCon 2023", since: 2023-01-01)
