# Person Domain — Vocabulary

This document defines the entity types and relationship types for a person-focused knowledge graph. It is intended to be read by AI agents and human developers when creating a repository.

---

## Patterns in This Vocabulary

Before reading the full spec, understand these five conventions. When extending this vocabulary with new types, follow the same patterns for consistency.

1. **Temporal relationships use `startDate`/`endDate` properties** — not separate types for current vs. past. `WORKS_AT`, `LIVES_IN`, `MANAGES`, `MEMBER_OF`, `STUDIED_AT` all follow this pattern. Omit `endDate` to indicate the relationship is current. When a relationship ends, set `endDate` — don't delete it.

2. **Bidirectional relationships are created once.** `KNOWS`, `IS_FRIENDS_WITH`, `IS_RELATED_TO`, `IS_MARRIED_TO` are all marked bidirectional. Create them in one direction only — the graph engine traverses both ways automatically. If you extend with a new social relationship type, decide upfront whether it's bidirectional and mark it.

3. **Properties make relationships queryable.** A bare `WORKS_AT` tells you almost nothing. A `WORKS_AT` with `role: "software engineer"`, `department: "platform"`, `startDate: "2022-03-01"` is useful. Always include properties where information is available, especially on professional and location relationships.

4. **Recommended values, not enums.** Properties like `eventType`, `orgType`, `locationType` list recommended values but accept any string. In `open` governance mode, use a new value when none of the recommendations fit — don't force data into an ill-fitting category.

5. **Labels and summaries are first-class.** Every entity type defines a label convention and summary convention. Follow them — labels and summaries are what appear in search results and traversal output. Consistent conventions mean I can scan 20 results and make quick retrieval decisions.

---

## Entity Types

### Identity

The uniqueness anchor for a person. Every Person entity MUST have a corresponding Identity entity linked via `IS_IDENTITY_FOR`. Identity holds biographical constants — facts about who this human being is that do not change over time. These properties allow the system to distinguish two people who share the same name.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `firstName` | string | yes | Given name |
| `lastName` | string | yes | Family name |
| `middleName` | string | no | Middle name(s) |
| `dateOfBirth` | string | no | ISO 8601 date (e.g. `1990-03-15`) |
| `birthCountry` | string | no | Country of birth |

**Label convention:** `{firstName} {lastName}` (e.g. "John Smith"). When multiple people share the same name in one document, add context: `{firstName} {lastName} ({disambiguator})` (e.g. "John Smith (Nexus CTO)").

**Summary convention:** Brief biographical identification, e.g. "John Albert Smith, born 2000-01-30, New Zealand."

**Sparse identities are expected.** An Identity with just firstName and lastName is valid. Additional properties accumulate as more source documents are processed.

See `docs/identity-pattern.md` for the full identity pattern rationale and examples.

### Person

The central entity. Represents a single human individual as a participant in the knowledge graph. All graph relationships (WORKS_AT, LIVES_IN, KNOWS, etc.) attach to the Person entity. Biographical constants (name, DOB, birth country) live on the linked Identity entity.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `gender` | string | no | Self-identified gender |
| `email` | string | no | Primary email address |
| `phone` | string | no | Primary phone number |
| `nationality` | string | no | Country of nationality |

**Label convention:** `{firstName} {lastName}` (e.g. "Alice Johnson"). Must match the linked Identity label.

**Summary convention:** A one-line description of who the person is, e.g. "Software engineer at Acme Corp, based in London."

### Organization

A company, institution, team, or any named group of people.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `orgType` | string | no | e.g. `company`, `university`, `government`, `non-profit`, `team`, `association`, `club` |
| `industry` | string | no | Primary industry or sector |
| `website` | string | no | Primary website URL |
| `foundedDate` | string | no | ISO 8601 date |

**Label convention:** The organization's common name (e.g. "Acme Corp").

### Location

A named place — city, country, address, or landmark.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `locationType` | string | no | e.g. `city`, `country`, `address`, `region` |
| `country` | string | no | Country name or ISO code |
| `coordinates` | string | no | Lat/long if known (e.g. `51.5074,-0.1278`) |

**Label convention:** The place name, optionally qualified (e.g. "London, UK").

### Event

A significant life event or milestone tied to a person.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `eventType` | string | yes | See recommended values below |
| `date` | string | no | ISO 8601 date or date-time |
| `endDate` | string | no | ISO 8601 date (for events with duration) |
| `description` | string | no | Brief narrative of the event |

**Label convention:** `{eventType}: {short description}` (e.g. "graduation: BSc Computer Science").

**Recommended `eventType` values:**

| Value | Description |
|-------|-------------|
| `birth` | Date and place of birth |
| `graduation` | Completion of a qualification |
| `marriage` | Marriage or civil partnership |
| `divorce` | End of marriage or civil partnership |
| `promotion` | Career advancement |
| `relocation` | Moved to a new location |
| `retirement` | Retired from professional work |
| `death` | Date and place of death |
| `award` | Received a notable award or honor |
| `certification` | Achieved a professional certification |

These are recommendations — in `open` governance mode, the agent can create events with any `eventType` value.

---

## Relationship Types

### Identity

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `IS_IDENTITY_FOR` | Links an Identity to the Person it uniquely identifies | Identity → Person | no |

Every Person MUST have exactly one `IS_IDENTITY_FOR` relationship from an Identity entity. This relationship has no properties — it exists solely to connect the identity anchor to the person node.

### Social and Personal

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `KNOWS` | General acquaintance or connection | Person → Person | yes |
| `IS_FRIENDS_WITH` | Close personal friendship | Person → Person | yes |
| `IS_RELATED_TO` | Family relationship (use `relation` property to specify) | Person → Person | yes |
| `IS_MARRIED_TO` | Spousal relationship | Person → Person | yes |
| `IS_PARENT_OF` | Parent-child relationship | Person → Person | no |

#### Properties for `KNOWS`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `context` | string | no | How they know each other (e.g. "met at PyCon 2024", "introduced by Charlie", "university classmates") |
| `since` | string | no | ISO 8601 date — when the connection was established |

#### Properties for `IS_FRIENDS_WITH`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `context` | string | no | Origin or nature of the friendship (e.g. "childhood friends", "flatmates in London 2018") |
| `since` | string | no | ISO 8601 date — when the friendship began |

#### Properties for `IS_RELATED_TO`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `relation` | string | yes | e.g. `sibling`, `cousin`, `uncle`, `aunt`, `grandparent`, `grandchild`, `niece`, `nephew` |

#### Properties for `IS_MARRIED_TO`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `marriageDate` | string | no | ISO 8601 date |
| `endDate` | string | no | ISO 8601 date (if divorced or deceased) |

### Professional

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `WORKS_AT` | Employment relationship | Person → Organization | no |
| `MANAGES` | Direct management relationship | Person → Person | no |
| `FOUNDED` | Person founded the organization | Person → Organization | no |
| `MEMBER_OF` | Non-employment affiliation (board, club, association, community) | Person → Organization | no |

#### Properties for `WORKS_AT`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `role` | string | no | Job title or role |
| `department` | string | no | Department or team name |
| `startDate` | string | no | ISO 8601 date |
| `endDate` | string | no | ISO 8601 date (omit if current) |

#### Properties for `MANAGES`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `startDate` | string | no | ISO 8601 date |
| `endDate` | string | no | ISO 8601 date (omit if current) |

#### Properties for `MEMBER_OF`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `role` | string | no | Role within the organization (e.g. "board member", "treasurer", "volunteer") |
| `startDate` | string | no | ISO 8601 date |
| `endDate` | string | no | ISO 8601 date (omit if current) |

### Education

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `STUDIED_AT` | Person attended or studied at an institution | Person → Organization | no |

#### Properties for `STUDIED_AT`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `qualification` | string | no | Degree or qualification obtained (e.g. "BSc Computer Science", "MBA") |
| `field` | string | no | Field of study (e.g. "Computer Science", "Law") |
| `startDate` | string | no | ISO 8601 date |
| `endDate` | string | no | ISO 8601 date |

### Location

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `LIVES_IN` | Current or past residence | Person → Location | no |
| `BORN_IN` | Place of birth | Person → Location | no |
| `LOCATED_IN` | Organization headquarters or primary location | Organization → Location | no |

#### Properties for `LIVES_IN`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `startDate` | string | no | ISO 8601 date — when they moved there |
| `endDate` | string | no | ISO 8601 date (omit if current residence) |

### Events

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `EXPERIENCED` | Links a person to a life event | Person → Event | no |
| `OCCURRED_AT` | Links an event to a location | Event → Location | no |
| `INVOLVED_IN` | Links a person to an event they participated in (but isn't the primary subject) | Person → Event | no |

---

## Design Notes

- **Identity pattern.** Every Person has a linked Identity entity holding biographical constants. The Identity anchors uniqueness — its GUID is embedded in the Person's slug, ensuring two people with the same name have distinct slugs. See `docs/identity-pattern.md` for the full rationale.
- **Bidirectional relationships** (like `KNOWS`, `IS_FRIENDS_WITH`) only need to be created once. The graph engine traverses them in both directions automatically.
- **Prefer specific types over generic ones.** Use `IS_FRIENDS_WITH` rather than `KNOWS` when the relationship is clearly a friendship. Use `KNOWS` as the fallback for loose connections.
- **Temporal relationships** (e.g. past employment, previous residence) are handled via properties on the relationship (`startDate`, `endDate`), not by creating separate relationship types for current vs. past. When `endDate` is omitted, the relationship is assumed to be current.
- **Relationship types are normalized** to `SCREAMING_SNAKE_CASE` by the core library. You can pass any casing and it will be normalized automatically.
- **This vocabulary is extensible.** In `open` governance mode, the agent can propose new types at indexing time. Common extensions include `MENTORS`, `ATTENDED`, `REPORTS_TO`, `COLLABORATED_WITH`, and `RECOMMENDED_BY`.
