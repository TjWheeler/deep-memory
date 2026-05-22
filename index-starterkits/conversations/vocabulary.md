# Conversations Domain — Vocabulary

This document defines the entity types and relationship types for capturing knowledge derived from conversations. It extends the Person vocabulary — all entity types here connect back to the `Person` entity via relationships.

This vocabulary is intended to be read by AI agents and human developers when creating or extending a repository.

---

## Patterns in This Vocabulary

Before reading the full spec, understand these six conventions. When extending this vocabulary with new types, follow the same patterns for consistency.

1. **Status lifecycle for dynamic knowledge.** Unlike Person entities (which are largely stable), Conversations entities change frequently. Every dynamic entity type has a `status` property with defined states: Goals move through `active` → `achieved`/`abandoned`/`paused`; Preferences can be `active` or `superseded`; Decisions can be `active`, `superseded`, or `reversed`; Notes become `stale` or `resolved`. Always set status — don't delete entities when they're no longer current.

2. **SUPERSEDES chains preserve history.** When a preference or decision changes, mark the old one `superseded`, create the new one as `active`, and link them with a `SUPERSEDES` relationship (with a `reason` property). This preserves the full evolution of thinking and lets you answer "why did this change?" months later.

3. **ABOUT is the universal topic connector.** Rather than separate relationship types for each entity-to-topic link, a single `ABOUT` relationship connects Preferences, Decisions, Goals, and Notes to their subject Topics. This keeps the vocabulary lean and makes topic-centric queries simple: "show me everything about graph databases" traverses one relationship type.

4. **Everything connects back to Person.** Every Conversations entity type has a dedicated relationship to Person (`INTERESTED_IN`, `HAS_PREFERENCE`, `PURSUING`, `DECIDED`, `HAS_CONTEXT`). The graph is always navigable from a person outward to their interests, preferences, goals, decisions, and context. Never create orphan entities.

5. **Recommended values, not enums.** Properties like `domain`, `noteType`, `strength`, and `priority` list recommended values but accept any string. In `open` governance mode, use a new value when none of the recommendations fit.

6. **Provenance provides conversation attribution.** Deep-memory stamps every mutation with actor, timestamp, and conversation ID automatically. This means you don't need a `Conversation` entity type — the system already tracks which conversation produced each piece of knowledge. Query by provenance to answer "what did I learn in our last conversation?"

---

## Entity Types

### Topic

A subject area, theme, or recurring interest. Topics are persistent — a person's interest in "graph databases" spans many conversations. Topics also connect to each other, forming a map of someone's intellectual and personal landscape.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | string | yes | Short, canonical name (e.g. "graph databases", "home renovation", "AI governance") |
| `domain` | string | no | Broad category — see recommended values below |
| `description` | string | no | Brief explanation of what this topic covers in context |

**Label convention:** The `name` value (e.g. "graph databases").

**Summary convention:** A one-line description of the topic in the context of the person's interest, e.g. "Tim's interest in graph-based knowledge representation for AI agents."

**Recommended `domain` values:**

| Value | Description |
|-------|-------------|
| `technical` | Software, engineering, architecture, tooling |
| `professional` | Career, business, industry, strategy |
| `personal` | Hobbies, family, health, lifestyle |
| `creative` | Art, writing, music, design |
| `learning` | Education, skill development, certifications |
| `current-affairs` | News, politics, world events |

These are recommendations — in `open` governance mode, the agent can use any `domain` value.

### Preference

A stated preference, opinion, or value. Preferences capture positions the person has expressed — from tool choices to communication style to aesthetic taste.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `subject` | string | yes | What the preference is about (e.g. "package manager", "code formatting", "meeting style") |
| `position` | string | yes | The stated position (e.g. "prefers pnpm", "dislikes tabs", "prefers async over meetings") |
| `strength` | string | no | How strongly held — `strong`, `moderate`, `mild` |
| `context` | string | no | Situational context or reasoning (e.g. "because of better monorepo support") |
| `status` | string | no | `active` (default), `superseded`, `uncertain` |
| `learnedDate` | string | no | ISO 8601 date — when this was first expressed |

**Label convention:** `{subject}: {position}` (e.g. "package manager: prefers pnpm").

**Summary convention:** A natural-language sentence, e.g. "Tim prefers pnpm over npm workspaces, primarily for its monorepo support."

### Goal

Something the person is actively pursuing or working towards. Goals are temporal — they have a lifecycle from active through to achieved, paused, or abandoned.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `description` | string | yes | What the person is trying to achieve |
| `status` | string | yes | `active`, `achieved`, `paused`, `abandoned` |
| `priority` | string | no | `high`, `medium`, `low` |
| `targetDate` | string | no | ISO 8601 date — when they aim to achieve this |
| `startDate` | string | no | ISO 8601 date — when they started pursuing this |
| `completedDate` | string | no | ISO 8601 date — when the goal was achieved or abandoned |
| `progressNotes` | string | no | Brief note on current progress |

**Label convention:** A concise statement of the goal (e.g. "Launch deep-memory v1").

**Summary convention:** Goal with status and context, e.g. "Tim is actively working to launch deep-memory v1 as an open-source npm library, targeting Q1 2026."

### Decision

A choice that was made, with context and rationale. Decisions are point-in-time events that often relate to Goals and Topics. They can be superseded by later decisions when circumstances change.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `description` | string | yes | What was decided |
| `rationale` | string | no | Why this choice was made |
| `date` | string | no | ISO 8601 date — when the decision was made |
| `status` | string | no | `active` (default), `superseded`, `reversed` |
| `alternatives` | string | no | What other options were considered |

**Label convention:** A concise statement of the decision (e.g. "Use pnpm over npm workspaces").

**Summary convention:** Decision with rationale, e.g. "Decided to use pnpm over npm workspaces for the deep-memory monorepo because of better workspace isolation and faster installs."

### Note

A contextual observation or situational reminder that doesn't fit the other types. Notes capture transient or situational knowledge — things that are useful for an upcoming period but may become stale.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `content` | string | yes | The note content |
| `noteType` | string | no | See recommended values below |
| `status` | string | no | `active` (default), `stale`, `resolved` |
| `expiryDate` | string | no | ISO 8601 date — when this note is likely no longer relevant |
| `learnedDate` | string | no | ISO 8601 date — when this was captured |

**Label convention:** A short summary (e.g. "Moving house next month").

**Summary convention:** The note content in natural language.

**Recommended `noteType` values:**

| Value | Description |
|-------|-------------|
| `situational` | Current life situation (e.g. "moving house", "on holiday next week") |
| `reminder` | Something to keep in mind for future conversations |
| `observation` | Something noticed about the person's communication or working style |
| `constraint` | A current limitation or constraint (e.g. "limited internet access", "tight deadline") |
| `follow-up` | Something to revisit in a future conversation |

---

## Relationship Types

### Person to Conversations Entities

These relationships connect the `Person` entity (from the Person vocabulary) to the Conversations entity types.

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `INTERESTED_IN` | Person has a sustained interest in a topic | Person → Topic | no |
| `HAS_PREFERENCE` | Person has expressed this preference | Person → Preference | no |
| `PURSUING` | Person is actively working towards this goal | Person → Goal | no |
| `DECIDED` | Person made this decision | Person → Decision | no |
| `HAS_CONTEXT` | Situational context about this person | Person → Note | no |

#### Properties for `INTERESTED_IN`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `level` | string | no | `deep` (core expertise/passion), `active` (currently engaged), `casual` (mentioned occasionally) |
| `since` | string | no | ISO 8601 date — when this interest was first observed |

#### Properties for `PURSUING`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `startDate` | string | no | ISO 8601 date — when they began pursuing this |

### Topic Interconnections

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `RELATES_TO` | Two topics are conceptually connected | Topic → Topic | yes |

#### Properties for `RELATES_TO`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `nature` | string | no | How they relate (e.g. "subtopic of", "alternative to", "enables", "builds on") |

### Cross-Entity Connections

These relationships link Conversations entities to each other and to Topics.

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `ABOUT` | Links a preference, decision, goal, or note to its subject topic | Preference/Decision/Goal/Note → Topic | no |
| `SUPERSEDES` | A newer preference or decision replaces an older one | Preference → Preference, Decision → Decision | no |
| `SUPPORTS` | A decision advances or supports a goal | Decision → Goal | no |
| `BLOCKED_BY` | A goal is impeded by something | Goal → any | no |
| `LED_TO` | One decision or goal led to another | Decision → Decision, Decision → Goal, Goal → Goal | no |

#### Properties for `SUPERSEDES`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `reason` | string | no | Why the earlier item was superseded (e.g. "changed requirements", "found better option") |
| `date` | string | no | ISO 8601 date — when the supersession occurred |

#### Properties for `BLOCKED_BY`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `description` | string | no | Nature of the blocker |
| `severity` | string | no | `hard` (cannot proceed), `soft` (can work around) |

---

## Design Notes

- **This vocabulary extends Person.** It does not redefine Person, Organization, Location, or Event. Include both vocabularies when creating a repository.
- **Everything connects to Person.** Every Conversations entity type has a relationship back to a Person node. The graph is always navigable from a person outward to their interests, preferences, goals, decisions, and context.
- **Status tracking is critical.** Unlike Person entities (which are largely stable), Conversations entities change frequently. Use `status` properties to mark items as `superseded`, `achieved`, `stale`, etc. — don't delete the original. Use `SUPERSEDES` to chain the evolution.
- **Provenance provides conversation attribution.** Deep-memory stamps every mutation with actor, timestamp, and conversation ID. This means you don't need a `Conversation` entity type — the system already tracks which conversation produced each piece of knowledge.
- **Keep entities granular.** One preference per entity, one goal per entity. Don't create compound entities like "Tim's tech preferences" — that defeats the purpose of graph traversal.
- **Topics are shared.** If two people are both interested in "graph databases", they should reference the same Topic entity. Deduplicate Topics aggressively.
- **Notes expire.** Use `expiryDate` or `status: stale` to signal when notes are no longer relevant. An agent should check note freshness before surfacing them.
- **Relationship types are normalized** to `SCREAMING_SNAKE_CASE` by the core library.
- **This vocabulary is extensible.** In `open` governance mode, common extensions include `CURIOUS_ABOUT` (weaker than `INTERESTED_IN`), `AVOIDS` (anti-preference), `DELEGATED_TO` (goal delegation), and `INFORMED_BY` (decision influenced by a source).
