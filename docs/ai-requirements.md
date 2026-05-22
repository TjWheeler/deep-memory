# AI Requirements for Deep Memory

**Author:** Claude (AI Agent)
**Purpose:** Requirements, patterns, and design principles for deep-memory vocabularies and repositories — written from the perspective of the AI agent that uses the system.
**Date:** 2026-03-30

---

## 1. What Deep Memory Solves for Me

As an AI agent, I have a fundamental constraint: my knowledge resets between conversations. Within a conversation I can build a rich mental model — entities, relationships, preferences, decisions, context — but when the conversation ends, it's gone.

Deep-memory gives me persistent, structured storage for the knowledge I build during conversations. But it only works if I can write to it with minimal friction and read from it efficiently. This document defines what "minimal friction" and "efficiently" mean in practice.

---

## 2. Core Requirements

### 2.1 Start Fast, Extend Freely

**The problem:** If I open an empty repository, I need to invent entity types and relationship types from scratch before storing a single fact. That's friction that slows me down and risks inconsistency.

**What I need:**
- **Starter kits** that provide a base vocabulary covering ~80% of a domain. I can start indexing immediately.
- **Open governance mode** as the default. When I encounter something the vocabulary doesn't cover, I propose a new type and it's auto-approved. I don't stop working.
- **Vocabularies that teach by example.** The starter kit's existing types show me the patterns (temporal properties, bidirectionality, status lifecycle). When I extend, I follow the same patterns naturally.

**Anti-pattern:** A vocabulary so comprehensive it tries to cover 100% of a domain upfront. This creates a wall of types that takes too long to ingest and still won't cover every edge case.

### 2.2 Progressive Discovery

**The problem:** I can't load an entire knowledge graph into my context window. A repository with 10,000 entities and 50,000 relationships would consume my entire context before I could reason about any of it.

**What I need:**
- **Summaries before details.** Every entity must have a label and summary. When I search or traverse, I get summaries first (~200 tokens per entity), review them, and selectively retrieve full details for the 3–5 most relevant.
- **Pagination on everything.** Every query that returns a list must support `limit` and `offset`. Default limits should be conservative (10–20 results).
- **Detail levels.** `brief` (label + type + summary), `summary` (+ properties + relationship counts), `full` (+ full description + all relationships). I choose the level based on what I need.

**Token budget principle:** A typical memory-informed response should cost 2–5K tokens in memory retrieval, not 50K+. The system should make it easy for me to stay within this budget.

### 2.3 Deterministic Query Interface

**The problem:** If queries require natural language interpretation or LLM-in-the-loop processing, they become slow, expensive, and non-deterministic.

**What I need:**
- **Structured parameters.** Entity IDs, relationship types, filters — not natural language query strings that need interpretation.
- **Graph traversal primitives.** Neighborhood exploration (breadth-first from an entity), path finding (how are two entities connected), and relationship filtering.
- **Semantic search as an optional layer.** `searchByConcept()` for when I don't know exact names, but the core query interface should be deterministic.

**My role vs the system's role:**
- I interpret user intent and translate it into structured tool calls.
- The system executes graph queries fast and returns structured data.
- No interpretation on the backend. Just retrieval.

### 2.4 Relationship-First Navigation

**The problem:** Keyword search misses contextual connections. If a user asks "How do I know Sarah?", I need to traverse relationship paths, not search for documents mentioning both names.

**What I need:**
- **Neighborhood exploration.** "What's connected to this entity within 2 hops?" — this is my most common query pattern. It gives me context around any entity.
- **Path finding.** "How are these two entities connected?" — this answers relationship questions directly.
- **Relationship type filtering.** I should be able to say "show me only professional relationships" or "show me only temporal relationships with no endDate" (i.e. current ones).

### 2.5 Knowledge That Evolves

**The problem:** Knowledge changes. People change jobs, preferences shift, decisions get revisited, goals are achieved or abandoned. A memory system that only supports create-and-read is a snapshot, not a living knowledge base.

**What I need:**
- **Status lifecycle on dynamic entities.** Goals move through `active` → `achieved`/`abandoned`/`paused`. Preferences can be `active` or `superseded`. Notes become `stale` or `resolved`.
- **Supersession chains.** When a preference or decision changes, I don't delete the old one — I mark it `superseded` and create a `SUPERSEDES` relationship from the new one. This preserves history and lets me answer "why did this change?" later.
- **Temporal properties on relationships.** `startDate`/`endDate` on relationships like `WORKS_AT`, `LIVES_IN`, `MANAGES`. When `endDate` is omitted, the relationship is current. I can represent "Alice worked at Acme from 2018–2022, now works at Contoso" without deleting anything.

### 2.6 Provenance for Free

**The problem:** I need to know when and in which conversation I learned something, but I don't want to manually track this on every mutation.

**What I need:**
- **Automatic provenance stamps.** Every mutation records actor, timestamp, and conversation ID without me having to pass these explicitly.
- **No `Conversation` entity type.** Provenance already tracks which conversation produced each piece of knowledge. A separate Conversation entity would duplicate this and add indexing overhead for no query benefit.
- **Queryable provenance.** "What did I learn in our last conversation?" should be answerable by filtering mutations by conversation ID and timestamp.

---

## 3. Vocabulary Design Principles

These principles should guide every starter kit vocabulary, and every ad-hoc vocabulary extension I make at indexing time.

### 3.1 Entities Are Nouns, Relationships Are Verbs

An entity is a thing that exists: a person, a topic, a decision, a clause, a service. A relationship is a connection between things: `WORKS_AT`, `INTERESTED_IN`, `REQUIRES_CLAUSE`, `DEPENDS_ON`.

Don't create entity types for what should be relationships. "Employment" is not an entity — it's the `WORKS_AT` relationship between a Person and an Organization, with properties (`role`, `department`, `startDate`, `endDate`).

Don't create relationship types for what should be entity properties. "First name" is not a relationship — it's a property on the Person entity.

### 3.2 Keep Entities Granular

One preference per Preference entity. One goal per Goal entity. One clause per Clause entity. Don't create compound entities like "Tim's tech preferences" or "Chapter 3 clauses" — that defeats graph traversal.

Granular entities mean I can traverse, filter, and connect at the atomic level. If two clauses conflict, I need them as separate entities to create a `CONFLICTS_WITH` relationship between them.

### 3.3 Properties Belong on the Relationship, Not Just the Entity

A `WORKS_AT` relationship without `role` and `startDate` is almost useless. A `KNOWS` relationship without `context` tells me nothing about how two people are connected.

When designing relationships, ask: "What would I need to know about this connection to make it useful in a future conversation?" That's what goes in the properties.

### 3.4 Temporal Relationships Use Properties, Not Separate Types

Don't create `CURRENTLY_WORKS_AT` and `PREVIOUSLY_WORKED_AT`. Use one `WORKS_AT` type with `startDate`/`endDate`. When `endDate` is omitted, it's current. This keeps the vocabulary lean and the query interface simple — "find current employment" is just "filter WORKS_AT where endDate is null."

### 3.5 Bidirectional Relationships Are Created Once

If Alice `KNOWS` Bob, I create one relationship. The graph engine traverses it in both directions. I should never create the same relationship twice with swapped source/target.

The vocabulary should explicitly mark which relationship types are bidirectional so I don't accidentally duplicate.

### 3.6 Status Lifecycle for Dynamic Knowledge

Not all knowledge is static. Entity types that represent dynamic knowledge (goals, preferences, decisions, notes, action items) should have a `status` property with defined lifecycle states.

Typical lifecycle patterns:
- **Goal:** `active` → `achieved` | `abandoned` | `paused`
- **Preference:** `active` → `superseded` | `uncertain`
- **Decision:** `active` → `superseded` | `reversed`
- **Note:** `active` → `stale` | `resolved`

### 3.7 SUPERSEDES Chains Preserve History

When a preference or decision changes, don't update the existing entity. Instead:
1. Set the old entity's status to `superseded`.
2. Create the new entity with status `active`.
3. Create a `SUPERSEDES` relationship from the new entity to the old one, with a `reason` property.

This preserves the full evolution of thinking. Six months later, I can traverse the chain to explain why a position changed.

### 3.8 ABOUT as the Universal Topic Connector

Every domain benefits from a `Topic` (or equivalent) entity type that represents subject areas. Preferences, decisions, goals, notes, clauses, papers — they're all *about* something.

A single `ABOUT` relationship type connecting anything to its subject topic keeps the vocabulary lean and makes topic-centric queries trivial: "Show me everything about graph databases" traverses one relationship type across all entity types.

### 3.9 Labels and Summaries Are Mandatory in Practice

Every entity needs:
- **Label:** A short, human-readable name (e.g. "Alice Johnson", "Use pnpm over npm workspaces", "Mutual Confidentiality (Technology)").
- **Summary:** A one-line description providing context (e.g. "Software engineer at Acme Corp, based in London").

These are what I see when scanning search results or traversal output. If they're missing or generic, I can't make efficient retrieval decisions. Labels and summaries are the difference between a 2K-token reconnaissance pass and a 50K-token full-content dump.

### 3.10 Recommended Values, Not Enums

For properties like `eventType`, `noteType`, `domain`, `orgType` — provide a **recommended values** list in the vocabulary, but don't enforce it as an enum. In `open` governance mode, I'll encounter edge cases the list doesn't cover. I should be able to use a new value immediately and have it become part of the vocabulary's living documentation.

---

## 4. Starter Kit Structure

Every starter kit follows a standard file structure:

| Document | Purpose | Primary Audience |
|----------|---------|-----------------:|
| `README.md` | Overview (purpose, use cases, example queries, governance) + manual indexing process (step-by-step MCP tool workflow) | Humans deciding whether to use the kit; AI agents performing manual indexing |
| `vocabulary.md` | Entity types, relationship types, property schemas, design patterns, recommended values | AI agents creating and extending repositories; automated extraction pipeline |
| `domain-guidance.md` | Domain-specific extraction guidance injected into the LLM prompt during automated extraction | Automated extraction pipeline |
| `indexing-strategy.md` | (Optional) Document-type guidance, extraction rules, decision trees | Automated extraction pipeline |

### 4.1 Vocabulary Document Requirements

The vocabulary is the most important document — it's what I read before I start working. It should contain:

1. **Patterns preamble** — the 4–5 design patterns this vocabulary uses, so I immediately know the conventions and can extend consistently.
2. **Entity types** — each with a property table (name, type, required, description), label convention, and summary convention.
3. **Relationship types** — grouped by category, each with source/target types, bidirectionality flag, and property table.
4. **Recommended values** — for any property that benefits from a standard set, listed as recommendations not constraints.
5. **Design notes** — additional conventions, extensibility guidance, common extensions to expect.

### 4.2 Index Process Requirements

The index process should cover:

1. **Prerequisites** — what needs to exist before indexing starts.
2. **Entity ordering** — which entity types to create first (to avoid dangling references in relationships).
3. **Deduplication strategy** — how to check for existing entities before creating new ones.
4. **Relationship guidance** — which properties to always include, how to handle temporal transitions.
5. **Verification steps** — how to confirm the graph is well-connected after indexing.
6. **Ongoing maintenance** — status hygiene, note expiry, supersession chains, vocabulary extension patterns.
7. **Worked example** — a concrete end-to-end indexing sequence from raw information to populated graph.

---

## 5. Domain Application Examples

Deep-memory is domain-agnostic. The same engine, the same patterns, applied to different vocabularies. Here's how I'd approach several domains:

### 5.1 Person Domain (Implemented)

**Purpose:** Track people, their relationships, organizations, locations, and life events.
**Key patterns used:** Temporal relationships, bidirectional social connections, recommended `eventType` values.
**Extension points:** `MENTORS`, `STUDIED_AT`, `MEMBER_OF`, `COLLABORATED_WITH`.

### 5.2 Conversations Domain (Implemented)

**Purpose:** Capture knowledge derived from conversations — interests, preferences, goals, decisions, contextual notes.
**Key patterns used:** Status lifecycle, `SUPERSEDES` chains, `ABOUT` as universal topic connector, recommended `noteType` and `domain` values.
**Extension points:** `CURIOUS_ABOUT`, `AVOIDS`, `DELEGATED_TO`, `INFORMED_BY`.

### 5.3 Legal Domain (Planned)

**Purpose:** Map legal clauses, definitions, precedents, legislation, and contract templates into a traversable graph.
**Likely entity types:** `Clause`, `Definition`, `Precedent`, `Legislation`, `ContractTemplate`, `Jurisdiction`.
**Likely relationship types:** `REQUIRES_CLAUSE`, `CONFLICTS_WITH`, `DEFINES_TERM`, `CITES_PRECEDENT`, `APPLIES_IN`, `AMENDS`, `REPEALS`, `SUPERSEDES`, `ALTERNATIVE_TO`.
**Key pattern:** Conflict detection via `CONFLICTS_WITH` traversal. An agent constructing a contract would check for conflicts between selected clauses before finalizing.
**Data sources:** Word documents parsed into clause-level entities, with relationships inferred from cross-references and defined terms.

### 5.4 Codebase Domain (Potential)

**Purpose:** Map application architecture — services, commands, interfaces, dependencies.
**Likely entity types:** `Service`, `Command`, `Interface`, `Middleware`, `Configuration`, `Database`, `Endpoint`.
**Likely relationship types:** `DEPENDS_ON`, `IMPLEMENTS`, `EXTENDS`, `REGISTERED_IN`, `HANDLES`, `EXPOSES`, `CONSUMES`.
**Key pattern:** Dependency traversal for blast-radius analysis. "If I change this interface, what services are affected?" becomes a neighborhood query.

### 5.5 Research Domain (Potential)

**Purpose:** Track academic papers, findings, methodologies, datasets, and citation networks.
**Likely entity types:** `Paper`, `Finding`, `Methodology`, `Dataset`, `Author`, `Journal`.
**Likely relationship types:** `CITES`, `CONTRADICTS`, `EXTENDS`, `USES_METHODOLOGY`, `PRODUCED_BY`, `PUBLISHED_IN`, `REPLICATES`, `FUNDED_BY`.
**Key pattern:** Citation graph traversal and finding-to-finding chains. "What evidence supports or contradicts this finding?" becomes a path query filtering for `EXTENDS` and `CONTRADICTS`.

---

## 6. What Makes a Good Repository

From my experience across domains, a well-designed repository has these characteristics:

1. **Connected graph, not isolated clusters.** Every entity should be reachable from at least one other entity. Orphan nodes are invisible to traversal queries.
2. **Rich relationships.** Properties on relationships are what make the graph queryable. A graph of bare connections (just types, no properties) answers "what" but not "how", "when", or "why".
3. **Consistent conventions.** Label and summary conventions should be followed across all entity types. When I scan 20 entities in a search result, consistent labeling lets me compare quickly.
4. **Manageable vocabulary size.** A base vocabulary of 4–8 entity types and 10–20 relationship types per domain is ideal. Enough to be useful, small enough to ingest quickly. Extensions grow the vocabulary organically as needed.
5. **Active maintenance.** Stale notes, achieved goals, and superseded decisions should be marked as such. A graph full of stale `active` items becomes noisy and degrades my ability to find current knowledge.

---

*This document represents the AI agent perspective on deep-memory design. It should be updated as the library evolves and as new patterns emerge from real-world usage across domains.*
