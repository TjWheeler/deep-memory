# Conversations Domain Starter Kit

## Purpose

This starter kit defines a vocabulary and indexing process for capturing **knowledge derived from conversations** -- the interests, preferences, goals, decisions, and contextual notes that emerge when an AI agent talks with a person over time.

It is designed to be used **alongside the Person starter kit** in the same repository. Person covers who someone is (identity, relationships, employment, life events). Conversations covers what you've **learned about them through interaction** -- their opinions, current objectives, choices they've made, and situational context that makes future conversations feel informed.

## Target Use Cases

- **Long-term AI memory** -- remembering what a person cares about, what they're working towards, and what they've decided across sessions
- **Personalization** -- adapting responses based on known preferences, interests, and communication style
- **Continuity** -- "catching up" at the start of a new conversation with awareness of prior context
- **Goal tracking** -- understanding what someone is actively pursuing and what progress has been made
- **Decision history** -- recalling past choices and the rationale behind them, especially when revisiting a topic

## What the Graph Can Answer

Once populated alongside the Person vocabulary, an agent can answer questions like:

- "What are Tim's current goals?"
- "What has Tim decided about the deep-memory storage backend?"
- "What topics does Tim keep coming back to?"
- "Has Tim expressed a preference on testing frameworks?"
- "What was the context behind that pnpm decision?"
- "What's changed since we last spoke?" (combining provenance timestamps with goal/decision status)
- "What should I keep in mind for this conversation?" (active goals, recent decisions, open notes)

## When to Use This Kit

Use this starter kit when:

- An AI agent has **repeated conversations** with the same person and needs to build up contextual knowledge over time.
- The agent should remember **preferences, opinions, and decisions** -- not just facts.
- You want a structured alternative to flat key-value memory stores, with the ability to traverse relationships between what someone knows, cares about, and is working towards.

## Relationship to the Person Vocabulary

This vocabulary **extends** the Person vocabulary -- it does not replace it. The core `Person` entity type from the Person kit is the anchor node. All Conversations entity types connect back to Person via relationships like `INTERESTED_IN`, `HAS_PREFERENCE`, `PURSUING`, `DECIDED`, and `HAS_CONTEXT`.

When creating a repository, include both the Person and Conversations vocabularies together. In `open` governance mode, this happens naturally -- the agent proposes new types as needed and they're auto-approved.

## Governance Recommendation

**`open`** governance is strongly recommended. Conversation-derived knowledge is inherently dynamic -- new topics, unexpected preferences, and novel goals emerge constantly. The agent needs to extend the vocabulary on the fly without human approval gates slowing down the flow.

## Design Philosophy

**Capture outcomes, not transcripts.** This vocabulary is not about logging conversations -- provenance tracking (actor, timestamp, conversation ID) is already built into every deep-memory mutation. Instead, it captures the *distilled knowledge* that emerges: what someone is interested in, what they've decided, what they're pursuing.

**Everything connects back to Person.** A preference without a person is meaningless. A goal without an owner is unactionable. The graph should always be navigable from a Person node outward.

**Knowledge evolves.** Preferences change, goals get achieved or abandoned, decisions get superseded. The vocabulary includes `status` properties and `SUPERSEDES` relationships to track this evolution rather than overwriting history.

---

## Starter Kit Files

| File | Description |
|------|-------------|
| `vocabulary.md` | Entity and relationship type definitions for the conversations domain |
| `domain-guidance.md` | Extraction prompt guidance for AI agents |
| `README.md` | This file -- overview, automated extraction notes, and manual indexing process |

---

## Automated Extraction

The `vocabulary.md` and `domain-guidance.md` files in this starter kit are consumed by the indexing pipeline automatically when configured as a domain source.

However, conversations indexing is typically done **via MCP tools during live conversations** rather than through bulk document extraction. The natural workflow is for an AI agent to capture knowledge in real time as it emerges from dialogue, rather than processing conversation transcripts after the fact.

For bulk extraction configuration (e.g., processing archived conversation logs or structured notes), see [docs/indexer-extraction-guide.md](../../docs/indexer-extraction-guide.md).

---

## Manual Indexing Process (MCP Tools)

Step-by-step guidance for an AI agent capturing conversation-derived knowledge into a deep-memory repository that already contains the Person vocabulary.

---

### Prerequisites

- Read `vocabulary.md` in this folder to understand the available entity types and relationship types.
- The repository should already contain the Person vocabulary. If starting fresh, include both Person and Conversations vocabularies when creating the repository.
- The `Person` entity for the user should already exist. If not, create it first using the Person starter kit's index process.
- Ensure the MCP server is running and accessible.

---

### When to Index

Unlike the Person vocabulary -- which is typically indexed from a structured data source -- Conversations knowledge is captured **during and after natural conversations**. The agent should index when it observes:

- **An interest or passion** -- the person repeatedly discusses a topic, asks deep questions about it, or explicitly says they're interested in something.
- **A stated preference** -- the person expresses a position ("I prefer X over Y", "I don't like Z", "always use A for this kind of thing").
- **A goal or objective** -- the person describes something they're working towards or planning to achieve.
- **A decision** -- the person makes a choice, especially one with rationale ("I've decided to go with X because...").
- **Contextual information** -- the person shares situational details that would be useful to remember ("I'm on holiday next week", "we're migrating servers this month").

**Judgement call:** Not everything said in conversation warrants a graph entry. Index knowledge that would be **useful in a future conversation** -- things you'd want to remember next time you speak with this person. Routine task requests, transient clarifications, and small talk generally don't need indexing.

---

### Step 1 -- Ensure the Person Entity Exists

Before indexing any Conversations entities, confirm the Person node exists:

1. Use `find_entities` to search for the person by name.
2. If found, note the entity ID -- all Conversations relationships will source from this entity.
3. If not found, create the Person entity first using the Person vocabulary conventions.

---

### Step 2 -- Index Topics

Topics are the most reusable and stable entity type. Create them first since Preferences, Decisions, Goals, and Notes often link to Topics via the `ABOUT` relationship.

#### Creating Topics

1. **Deduplicate first.** Search for existing Topics before creating new ones. "Graph databases" and "knowledge graphs" might be related but are distinct topics -- create both and link with `RELATES_TO`. However, "graph DBs" and "graph databases" are the same topic -- don't duplicate.
2. **Use canonical names.** Prefer the most commonly used term as the label. Lowercase, natural language (e.g. "graph databases" not "GRAPH_DATABASES").
3. **Set the domain** where obvious (`technical`, `professional`, `personal`, etc.).
4. **Write a contextual summary** -- not a dictionary definition, but what this topic means in the context of the person's interest.

#### Linking Topics

- Create `INTERESTED_IN` from Person to Topic with `level` (`deep`, `active`, `casual`).
- Create `RELATES_TO` between connected Topics when the relationship is meaningful (e.g. "deep-memory" `RELATES_TO` "graph databases" with nature: "builds on").

---

### Step 3 -- Index Preferences

Preferences should be created as they're expressed in conversation. Each preference is a single, atomic position.

#### Creating Preferences

1. **One preference per entity.** "Prefers pnpm" and "prefers Turborepo" are two separate preferences, even if expressed in the same sentence.
2. **Capture the position clearly.** The `position` property should be self-contained -- readable without needing the `subject` (e.g. position: "prefers pnpm over npm workspaces for monorepos").
3. **Include context and rationale** when available. "Because of better workspace isolation" is enormously valuable later.
4. **Set strength** when the person signals it -- "I strongly prefer" vs "I guess I'd lean towards".
5. **Check for supersession.** If this preference contradicts an existing one, set the old preference's status to `superseded` and create a `SUPERSEDES` relationship from the new preference to the old one.

#### Linking Preferences

- Create `HAS_PREFERENCE` from Person to Preference.
- Create `ABOUT` from Preference to Topic if the preference relates to a topic in the graph.
- Create `SUPERSEDES` from new Preference to old Preference when a position has changed.

---

### Step 4 -- Index Goals

Goals represent active objectives. They have a lifecycle and should be updated as progress is made.

#### Creating Goals

1. **Write clear descriptions.** The `description` should be specific enough to track progress against (e.g. "Launch @utaba/deep-memory v1 as open-source npm library" not "work on deep-memory").
2. **Set status** -- always required. Most new goals are `active`.
3. **Set priority** when known or inferable.
4. **Include dates** -- `startDate` when the goal was first mentioned, `targetDate` if the person has a deadline in mind.

#### Updating Goals

- When a goal is achieved: set `status: achieved` and `completedDate`.
- When a goal is paused: set `status: paused` and update `progressNotes`.
- When a goal is abandoned: set `status: abandoned` and `completedDate`, optionally note why in `progressNotes`.
- When progress is made: update `progressNotes`.

#### Linking Goals

- Create `PURSUING` from Person to Goal.
- Create `ABOUT` from Goal to Topic if the goal relates to a known topic.
- Create `SUPPORTS` from Decision to Goal when a decision advances the goal.
- Create `BLOCKED_BY` from Goal to any entity representing an impediment.
- Create `LED_TO` from Goal to Goal when achieving one goal spawns another.

---

### Step 5 -- Index Decisions

Decisions are point-in-time choices. They're especially valuable when they include rationale and alternatives considered.

#### Creating Decisions

1. **Capture the choice and the reasoning.** A decision without rationale is just a fact -- the rationale is what makes it useful when the topic comes up again.
2. **Note alternatives** when the person mentions what else they considered.
3. **Set the date** -- when the decision was made or expressed.
4. **Check for supersession.** If this decision overrides a previous one, update the old decision's status and create a `SUPERSEDES` relationship.

#### Linking Decisions

- Create `DECIDED` from Person to Decision.
- Create `ABOUT` from Decision to Topic.
- Create `SUPPORTS` from Decision to Goal if the decision advances a goal.
- Create `SUPERSEDES` from new Decision to old Decision when a choice has been revisited.
- Create `LED_TO` from Decision to Decision or Decision to Goal for causal chains.

---

### Step 6 -- Index Notes

Notes are the catch-all for useful context that doesn't fit the other types. Use them sparingly -- if something is clearly a preference, goal, or decision, use that type instead.

#### Creating Notes

1. **Keep notes atomic and specific.** "Moving house next month" is a good note. "Various life updates" is not.
2. **Set noteType** to help with filtering later.
3. **Set expiryDate** when the note is clearly time-bound (e.g. "on holiday next week" -- expiry in one week).
4. **Set status** -- mark notes as `stale` or `resolved` when they're no longer relevant.

#### Linking Notes

- Create `HAS_CONTEXT` from Person to Note.
- Create `ABOUT` from Note to Topic if the note relates to a known topic.

---

### Step 7 -- Verify and Maintain

#### After Indexing

1. **Explore the person's neighborhood** -- use `explore_neighborhood` (depth 2) on the Person entity to confirm the new knowledge is well-connected.
2. **Check for orphans** -- every Conversations entity should have at least one relationship back to a Person and ideally an `ABOUT` link to a Topic.

#### Ongoing Maintenance

- **Status hygiene.** Periodically review active Goals, Preferences, and Notes. Mark stale items appropriately. An agent can do this at the start of a conversation by scanning for old `active` items.
- **Topic consolidation.** If two Topics emerge that are essentially the same concept, merge them -- update all relationships to point to the canonical one and remove the duplicate.
- **Note expiry.** Check `expiryDate` on Notes and mark expired ones as `stale`.
- **Supersession chains.** When updating a Preference or Decision, always create the `SUPERSEDES` link. This preserves history and lets future queries understand how thinking evolved.

---

### Example Indexing Sequence

Given a conversation where John says: "I've been thinking about the deep-memory library. I've decided to use pnpm instead of npm workspaces -- the workspace isolation is just better. My goal is to get v1 out as open source by end of Q1. Oh, and I'm migrating my workstation from Windows to Linux Mint this month."

1. **Find or create Person:** "John Smith" (should already exist)
2. **Find or create Topic:** "deep-memory" (domain: technical)
3. **Find or create Topic:** "package management" (domain: technical)
4. Create `RELATES_TO`: "package management" to "deep-memory" (nature: "tooling for")
5. **Create Decision:** "Use pnpm over npm workspaces" (rationale: "better workspace isolation", alternatives: "npm workspaces", status: active)
6. Create `DECIDED`: Tim to Decision
7. Create `ABOUT`: Decision to "package management"
8. **Create Goal:** "Launch deep-memory v1 as open source" (status: active, priority: high, targetDate: 2026-03-31)
9. Create `PURSUING`: Tim to Goal
10. Create `ABOUT`: Goal to "deep-memory"
11. Create `SUPPORTS`: Decision (pnpm) to Goal (launch v1)
12. **Create Note:** "Migrating workstation from Windows to Linux Mint" (noteType: situational, status: active, expiryDate: 2026-04-30)
13. Create `HAS_CONTEXT`: Tim to Note
