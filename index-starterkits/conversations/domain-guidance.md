# Conversations Domain — Domain Guidance

This document provides domain-specific knowledge for AI agents capturing knowledge from conversations into a deep-memory repository. It supplements the vocabulary (what to capture) and the index process (how to capture) with guidance on judgment calls, common mistakes, and patterns that keep the graph useful over time.

This guidance is injected into the extraction prompt alongside the vocabulary. Follow it when making entity creation, labeling, and relationship decisions.

---

## Identity Pattern

This domain does **not** use Identity entities. Topics are canonical phrases, Preferences include subject and position, Goals state concrete objectives, and Decisions name the choice made. These label conventions produce inherently unique identifiers. The Person entities referenced via `INTERESTED_IN`, `HAS_PREFERENCE`, etc. should follow the identity pattern from the person domain vocabulary if person-level disambiguation is needed. See `docs/identity-pattern.md` for when identity is needed.

---

## Entity Naming Rules

These rules produce consistent, canonical labels that enable deduplication and efficient retrieval.

### Topic Labels

**Format:** Lowercase, natural language, canonical form.

| Correct | Incorrect |
|---------|-----------|
| `graph databases` | `Graph Databases` |
| `home renovation` | `Home Reno` |
| `AI governance` | `ai-governance` |
| `deep-memory` | `deep memory library` (too specific for a Topic — use the project name) |

**Use the most commonly used term.** If the person says "knowledge graphs" in one conversation and "graph databases" in another, pick the one they use most often as the canonical label. Add the other as an alias.

**Project names are valid Topic labels.** `deep-memory`, `kubernetes`, `react` are all legitimate Topics. Use the project's canonical casing (lowercase for npm packages, etc.).

**Don't create overly broad Topics.** `technology` is too vague to be useful. `TypeScript build tooling` is specific enough to be actionable.

**Don't create overly narrow Topics.** `pnpm workspace hoisting behavior` is too specific — that's a Preference or Decision about the Topic `package management` or `pnpm`.

### Preference Labels

**Format:** `{subject}: {position}`

| Correct | Incorrect |
|---------|-----------|
| `package manager: prefers pnpm` | `pnpm` |
| `code formatting: dislikes tabs` | `Tabs vs spaces` |
| `meetings: prefers async communication` | `Doesn't like meetings` |

**The label must be self-contained.** Someone reading the label should understand the preference without loading the entity details.

### Goal Labels

**Format:** A concise statement of the objective.

| Correct | Incorrect |
|---------|-----------|
| `Launch deep-memory v1` | `Work on deep-memory` |
| `Pass AWS Solutions Architect exam` | `Study for certification` |
| `Migrate from Windows to Linux` | `Linux migration` |

**Goals are specific and measurable where possible.** If the person says "I want to learn more about Kubernetes", that's a Topic interest (`INTERESTED_IN`), not a Goal — unless they state a concrete objective like "Get CKA certified by June."

### Decision Labels

**Format:** A concise statement of the choice made.

| Correct | Incorrect |
|---------|-----------|
| `Use pnpm over npm workspaces` | `Package manager decision` |
| `Deploy to Azure instead of AWS` | `Cloud provider` |
| `Adopt vitest for testing` | `Testing framework` |

**Include what was chosen AND what was rejected (if stated).** The "over X" or "instead of Y" phrasing preserves context that's valuable when the topic comes up again.

### Note Labels

**Format:** A short summary of the situation.

| Correct | Incorrect |
|---------|-----------|
| `Moving house next month` | `Life update` |
| `Limited internet access until March` | `Connectivity issues` |
| `Team is short-staffed this sprint` | `Work stuff` |

---

## Relationship Referencing Rules

**Every `sourceLabel` and `targetLabel` in a relationship MUST exactly match the `label` of an entity you have created.** This is the single most important rule for preventing orphan relationships.

When creating a relationship:
1. Check the entity label you assigned earlier in this extraction
2. Use that exact label in `sourceLabel` or `targetLabel`
3. Do NOT use alternate phrasings or abbreviations

---

## Judgment Calls: When to Create What

The hardest part of Conversations indexing is deciding *what* to capture and *which entity type* to use. These guidelines help.

### Topic vs Preference vs Decision

| What the Person Said | Entity Type | Why |
|----------------------|-------------|-----|
| "I'm really interested in graph databases" | Topic + `INTERESTED_IN` | Sustained interest, no position taken |
| "I prefer graph databases over relational for this use case" | Preference | Position stated with context |
| "We're going with Neo4j for the knowledge graph" | Decision | Choice made, implies alternatives were considered |
| "Graph databases are interesting but I haven't looked into them much" | Topic + `INTERESTED_IN` (level: casual) | Mild interest, no position |

### Topic vs Goal

| What the Person Said | Entity Type | Why |
|----------------------|-------------|-----|
| "I want to learn Rust" | Goal (status: active) | Concrete objective with implied action |
| "Rust is fascinating" | Topic + `INTERESTED_IN` | Interest expressed, no objective stated |
| "I'm working through the Rust book" | Goal (with progressNotes) | Active pursuit with progress |

### Preference vs Note

| What the Person Said | Entity Type | Why |
|----------------------|-------------|-----|
| "I always use dark mode" | Preference | Persistent position |
| "I'm using dark mode this week because of eye strain" | Note (situational) | Temporary, context-specific |
| "I don't like meetings longer than 30 minutes" | Preference | Persistent position |
| "I can't do meetings this week, I'm on deadline" | Note (constraint) | Temporary constraint |

### When NOT to Create an Entity

Not everything said in conversation warrants a graph entry. Skip:

- **Routine task requests:** "Can you fix this bug?" — this is a task, not knowledge
- **Transient clarifications:** "I meant the other file" — ephemeral context
- **Small talk:** "Nice weather today" — not useful in future conversations
- **Opinions on things unrelated to their work or interests:** Unless the person clearly cares about the topic
- **Restatements of existing knowledge:** If the entity already exists with the same information, don't duplicate

**The test:** "Would knowing this make a future conversation more helpful?" If yes, capture it. If no, skip it.

---

## Status Lifecycle Management

Unlike Person entities (which are largely stable), Conversations entities are dynamic. Getting status transitions right is critical.

### Status Transition Rules

**Goals:**
```
active → achieved    (objective met)
active → paused      (temporarily on hold)
active → abandoned   (no longer pursuing)
paused → active      (resumed)
```

**Preferences:**
```
active → superseded  (replaced by a new preference)
active → uncertain   (person expressed doubt)
```

**Decisions:**
```
active → superseded  (replaced by a new decision)
active → reversed    (explicitly undone)
```

**Notes:**
```
active → stale       (no longer relevant)
active → resolved    (situation has been addressed)
```

### SUPERSEDES Chains

When a Preference or Decision changes, ALWAYS:
1. Set the old entity's status to `superseded`
2. Create the new entity with status `active`
3. Create a `SUPERSEDES` relationship from new → old with a `reason` property

**Wrong:** Updating the old Preference's `position` property in place.
**Right:** Creating a new Preference and linking it via `SUPERSEDES`.

This preserves history. An agent can later answer "why did Tim switch from npm to pnpm?" by traversing the supersession chain.

---

## Anti-Hallucination Rules

### Rule 1: Only capture what was explicitly stated

Do NOT infer unstated preferences, goals, or decisions from behavior:

| Observation | Wrong | Right |
|-------------|-------|-------|
| Person always writes TypeScript | Create Preference "prefers TypeScript" | Don't create anything (behavioral pattern, not stated preference) |
| Person has been working on feature X for weeks | Create Goal "Complete feature X" | Only create if they explicitly stated it as a goal |
| Person used vitest in their last project | Create Decision "Use vitest for testing" | Only create if they explicitly chose vitest over alternatives |

**Exception:** If the person's behavior is so consistent that it's clearly a strong preference, you may create a Preference with `strength: mild` and note in the `context` that it was inferred from behavior, not stated.

### Rule 2: Don't over-connect to Topics

Not every entity needs an `ABOUT` link to a Topic. Only create `ABOUT` when the connection is meaningful and the Topic already exists or clearly should exist.

**Wrong:** Creating a Topic "email" just to link a Note "Check inbox before standup" to it.
**Right:** Linking a Decision "Use SendGrid over Mailgun" to an existing Topic "email infrastructure".

### Rule 3: Preserve the person's own words

When writing `position` (Preference), `description` (Goal/Decision), or `content` (Note), use language close to what the person actually said. Don't editorialize or generalize:

| Person Said | Wrong | Right |
|-------------|-------|-------|
| "pnpm is way better for monorepos" | position: "pnpm is the optimal package manager" | position: "prefers pnpm, says it's way better for monorepos" |
| "I want to get v1 out by end of Q1" | description: "Release version 1.0 of the software" | description: "Get v1 out by end of Q1" |

---

## Common Extraction Pitfalls

### 1. Creating compound entities

**Wrong:** One Preference entity with subject "development tools" and position "prefers pnpm, vitest, and TypeScript".
**Right:** Three separate Preferences — one for package manager, one for testing framework, one for language.

Each preference should be atomic so it can be individually superseded, queried, and linked to the right Topic.

### 2. Missing Person links

Every Conversations entity MUST have a relationship back to a Person:
- Topic → `INTERESTED_IN` from Person
- Preference → `HAS_PREFERENCE` from Person
- Goal → `PURSUING` from Person
- Decision → `DECIDED` from Person
- Note → `HAS_CONTEXT` from Person

An entity without a Person link is an orphan and will never be discovered through normal graph traversal.

### 3. Topic proliferation

Don't create a new Topic for every slight variation:

| These Are the Same Topic | These Are Different Topics |
|-------------------------|---------------------------|
| `graph databases`, `graph DBs` | `graph databases` vs `knowledge graphs` |
| `TypeScript`, `TS` | `TypeScript` vs `JavaScript` |
| `deep-memory`, `deep memory` | `deep-memory` (project) vs `knowledge graphs` (concept) |

Before creating a Topic, search for existing ones that cover the same concept. Use `find_entities` with the Topic type.

### 4. Stale entities accumulating

Periodically review active Goals, Notes, and Preferences. An agent can do this at the start of a conversation:
- Goals with `startDate` older than 6 months and no `progressNotes` update may be stale
- Notes with `expiryDate` in the past should be marked `stale`
- Notes with `noteType: situational` older than 30 days are likely stale

### 5. Confusing interest level with preference strength

| Concept | Entity Type | Property |
|---------|-------------|----------|
| How much someone cares about a topic | `INTERESTED_IN` relationship | `level: deep/active/casual` |
| How strongly someone holds an opinion | Preference entity | `strength: strong/moderate/mild` |

A person can be deeply interested in a topic (`level: deep`) but hold only a mild preference about a specific aspect of it (`strength: mild`). These are independent dimensions.
