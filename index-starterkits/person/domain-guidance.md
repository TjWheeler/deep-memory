# Person Domain — Domain Guidance

This document provides domain-specific knowledge for AI agents extracting entities and relationships from person-related source data. It supplements the vocabulary (what to extract) and the index process (how to extract) with knowledge about naming conventions, common data patterns, and pitfalls that prevent extraction errors.

This guidance is injected into the extraction prompt alongside the vocabulary. Follow it when making labeling, grouping, and relationship decisions.

---

## MANDATORY Extraction Checklist

You MUST follow these steps in order for every document. Do NOT skip steps.

1. **Create Identity + Person pairs for every named individual.** For every person in the source, you MUST create BOTH an Identity entity (with firstName, lastName, and any other biographical constants the source provides) AND a Person entity (with label and summary). Then create an `IS_IDENTITY_FOR` relationship from the Identity to the Person. Every Person MUST have exactly one linked Identity.
2. **Extract ALL Organization entities.** Every named company, university, team, non-profit, government body, or club MUST become an Organization entity. If a person works at, studied at, or is a member of an organization, that organization MUST exist as an entity.
3. **Extract ALL Location entities.** Every named city, country, region, or address MUST become a Location entity. If a person lives in, was born in, or relocated to a place, that place MUST exist as an entity.
4. **Extract ALL Event entities.** Every graduation, promotion, relocation, award, marriage, retirement, or other significant life event MUST become an Event entity with the correct `eventType`.
5. **Create ALL professional relationships.** You MUST create a `WORKS_AT` relationship for every employment mention, a `STUDIED_AT` for every education mention, a `FOUNDED` for every founding mention, and a `MEMBER_OF` for every non-employment affiliation. Each relationship MUST have `role` and `startDate` where the source provides them. All relationships attach to the **Person** entity, not the Identity.
6. **Create ALL social/personal relationships.** You MUST create `KNOWS`, `IS_FRIENDS_WITH`, `IS_RELATED_TO`, `IS_MARRIED_TO`, or `IS_PARENT_OF` for every stated connection between people. These attach to Person entities.
7. **Create ALL location relationships.** You MUST create `LIVES_IN` for every residence mention, `BORN_IN` for every birthplace, and `LOCATED_IN` for every organization headquarters or primary location.
8. **Create ALL event relationships.** Every Event entity MUST have at least one `EXPERIENCED` or `INVOLVED_IN` relationship linking it to a Person. Every Event MUST have an `OCCURRED_AT` relationship linking it to a Location when the location is known. An Event with no Person link is an orphan — this is an extraction failure.
9. **Decompose compound paragraphs.** A single paragraph describing a career history MUST produce multiple `WORKS_AT` relationships with distinct date ranges. A paragraph listing multiple qualifications MUST produce multiple `STUDIED_AT` relationships. Never collapse multiple facts into a single relationship.
10. **Verify label matching.** After creating all entities and relationships, check that every `sourceLabel` and `targetLabel` in every relationship exactly matches an entity label you created. Fix any mismatches before finishing.

---

## Identity Pattern

This domain uses the **Identity pattern** for Person entities. Every Person MUST have a linked Identity entity. See `docs/identity-pattern.md` for the full rationale.

### What Goes Where

| Entity | Properties | Purpose |
|--------|-----------|---------|
| **Identity** | firstName, lastName, middleName, dateOfBirth, birthCountry | Biographical constants — who this human being IS |
| **Person** | gender, email, phone, nationality, label, summary | Graph participation — what this person DOES and how to contact them |

### Extraction Flow

For each named individual in the source:
1. Create an **Identity** entity with biographical constants from the source text
2. Create a **Person** entity with label, summary, and contact properties
3. Create `IS_IDENTITY_FOR` from Identity → Person
4. Attach all other relationships (WORKS_AT, LIVES_IN, KNOWS, etc.) to the **Person**, not the Identity

### Stub Identities

When the source only provides a name (e.g., "Alice Johnson mentioned in passing"), create both entities anyway:
- Identity: `firstName: Alice, lastName: Johnson` (no other properties)
- Person: label `Alice Johnson`, summary from context

Sparse identities are normal. Properties accumulate as more documents are processed.

### Same-Name Disambiguation

When the same document contains multiple people with the same name, add a disambiguator to both the Identity and Person labels:
- `John Smith (Nexus CTO)` / `John Smith (intern)`

When different documents contain same-name people, the Identity properties (middleName, dateOfBirth, birthCountry) allow the consolidator to detect the collision and keep them separate.

---

## Entity Naming Rules

These rules produce consistent, canonical labels that prevent duplicate entities and orphan relationships across documents.

### Identity Labels

**Format:** `{firstName} {lastName}` — same as the Person label.

When multiple people share the same name in one document, add context: `{firstName} {lastName} ({disambiguator})`.

| Scenario | Identity Label |
|----------|---------------|
| Only one John Smith in the document | `John Smith` |
| Two John Smiths, different companies | `John Smith (Nexus CTO)` / `John Smith (Orion engineer)` |
| Two John Smiths, same company | `John Smith (sales)` / `John Smith (engineering)` |

### Person Labels

**Format:** `{firstName} {lastName}`

Always use the person's most commonly used legal name, not nicknames or abbreviations:

| Correct | Incorrect |
|---------|-----------|
| `Alice Johnson` | `A. Johnson` |
| `Robert Smith` | `Bob Smith` (unless "Bob" is the person's known name) |
| `Maria Garcia Lopez` | `Maria Garcia` (do not drop compound surnames) |

**When to use informal names:** If the source consistently uses a short form and the full name is unknown, use what you have. `Bob Smith` is better than no entity. When the full name is later discovered, update the entity label and add the short form as an alias.

**Titles and honorifics are NOT part of the label.** "Dr. Alice Johnson" has label `Alice Johnson`. The title belongs in the summary or a property, not the label.

**Suffixes (Jr., Sr., III) ARE part of the label** when they distinguish individuals: `Robert Smith Jr.` vs `Robert Smith Sr.`.

### Organization Labels

**Format:** The organization's most commonly recognized name.

| Correct | Incorrect |
|---------|-----------|
| `Acme Corp` | `Acme Corporation Limited` (unless the legal name is needed for disambiguation) |
| `Imperial College London` | `Imperial College` (too ambiguous) |
| `Google` | `Alphabet Inc.` (unless specifically discussing the parent company) |

**Use the name people would search for.** If the source says "Google LLC" but everyone calls it "Google", use `Google` as the label. The legal name can go in a `legalName` property or the summary.

**Parent vs subsidiary:** If a source references both "Google" and "Alphabet", create separate entities and link with a relationship. Do not conflate them.

### Location Labels

**Format:** `{Place Name}, {Country/Region}` for cities and regions. Just `{Country}` for countries.

| Correct | Incorrect |
|---------|-----------|
| `London, UK` | `London` (ambiguous — London, Ontario exists) |
| `New York, USA` | `New York City` (unless distinguishing from New York State) |
| `Melbourne, Australia` | `Melbourne` (ambiguous) |
| `France` | `The French Republic` |

**You MUST qualify with country when ambiguous.** Many city names exist in multiple countries (Portland, Cambridge, Hamilton). When the source is unambiguous and the city is globally unique (e.g. Tokyo), the country qualifier is optional but still recommended for consistency.

### Event Labels

**Format:** `{eventType}: {short description}`

| Correct | Incorrect |
|---------|-----------|
| `graduation: BSc Computer Science` | `Graduated from university` |
| `promotion: Senior Engineer at Acme` | `Got promoted` |
| `relocation: Moved to London` | `Relocation` |

**Include the specifics that make the event identifiable.** A person may have multiple graduations or promotions — the label MUST distinguish them.

---

## Relationship Referencing Rules

**Every `sourceLabel` and `targetLabel` in a relationship MUST exactly match the `label` of an entity you have created.** This is the single most important rule for preventing orphan relationships.

When creating a relationship:
1. Check the entity label you assigned earlier in this extraction
2. Use that exact label in `sourceLabel` or `targetLabel`
3. Do NOT use abbreviations, nicknames, or alternate forms in relationships

Example — if you created a Person with label `Alice Johnson`:
- Relationship sourceLabel: `Alice Johnson` (correct)
- Relationship sourceLabel: `Alice` (WRONG — creates orphan)
- Relationship sourceLabel: `Dr. Alice Johnson` (WRONG — creates orphan)

---

## Decomposition Rules

Person data frequently packs multiple facts into a single paragraph. You MUST decompose these into separate entities and relationships.

### Career History Decomposition

A paragraph like: *"Alice worked at Orion Systems from 2017 to 2020, then joined Nexus Technologies in 2021 as a senior engineer"* MUST produce:

- `WORKS_AT` → Alice Johnson → Orion Systems (`startDate: 2017`, `endDate: 2020`)
- `WORKS_AT` → Alice Johnson → Nexus Technologies (`role: Senior Engineer`, `startDate: 2021`)

Do NOT create a single relationship summarizing the career. Each employment is a separate relationship with its own dates and role.

### Education Decomposition

*"Robert completed his BSc at Edinburgh in 2012 and his MSc in 2014"* MUST produce:

- `STUDIED_AT` → Robert Chen → University of Edinburgh (`qualification: BSc`, `endDate: 2012`)
- `STUDIED_AT` → Robert Chen → University of Edinburgh (`qualification: MSc`, `endDate: 2014`)

Two separate relationships, not one combined entry.

### Relocation Decomposition

*"She moved from London to Berlin in 2022"* MUST produce:

- `LIVES_IN` → Person → London, UK (`endDate: 2022`)
- `LIVES_IN` → Person → Berlin, Germany (`startDate: 2022`)

Set `endDate` on the old location. Create a new relationship for the new location. Never delete a relationship to represent a temporal transition.

### Role Change Decomposition

*"Robert joined as lead engineer in 2015 and was promoted to CTO in 2020"* MUST produce:

- `WORKS_AT` → Robert Chen → Orion Systems (`role: Lead Engineer`, `startDate: 2015`, `endDate: 2020`)
- `WORKS_AT` → Robert Chen → Orion Systems (`role: CTO`, `startDate: 2020`)

Each role is a separate relationship. A promotion ends one WORKS_AT and starts another at the same organization.

---

## Temporal Relationship Patterns

Person data is inherently temporal. Follow these patterns to preserve history accurately.

### Current vs Past Relationships

The vocabulary uses `startDate`/`endDate` properties on relationships — NOT separate types for current vs past. This is critical:

| Situation | Correct Approach | Wrong Approach |
|-----------|-----------------|----------------|
| Alice left Acme Corp in 2023 | `WORKS_AT` with `endDate: 2023-12-31` | Delete the `WORKS_AT` relationship |
| Alice moved from London to Berlin | Set `endDate` on `LIVES_IN` → London, create new `LIVES_IN` → Berlin | Delete the London relationship |
| Alice and Bob divorced | Set `endDate` on `IS_MARRIED_TO` | Delete `IS_MARRIED_TO` |

**Never delete a relationship to represent a temporal transition.** Set `endDate` and create a new relationship for the current state.

### Date Precision

Use the most precise date available, but don't fabricate precision:

| Source Says | Use This Date |
|-------------|---------------|
| "March 2022" | `2022-03` |
| "2022" | `2022` |
| "early 2022" | `2022` (note "early" in a property or summary) |
| "15 March 2022" | `2022-03-15` |

---

## Deduplication Patterns

### Person Deduplication

People are referenced by many different forms of their name. Before creating a Person entity, search for all plausible variations:

| Source Reference | Search For |
|-----------------|------------|
| `Dr. Robert J. Smith` | `Robert Smith`, `Bob Smith`, `R. Smith` |
| `Alice Johnson-Lee` | `Alice Johnson`, `Alice Lee`, `Alice Johnson-Lee` |
| `Prof. Maria Garcia Lopez` | `Maria Garcia Lopez`, `Maria Garcia` |

**When two names refer to the same person:** Use `update_entity` to merge properties onto the existing entity. Add the alternate name as an alias.

### Organization Deduplication

Organizations frequently appear under different names:

| Same Entity | Different Entities |
|-------------|-------------------|
| `Google`, `Google LLC`, `Google Inc.` | `Google` vs `Alphabet` (parent/subsidiary) |
| `Imperial College London`, `Imperial College` | `Imperial College London` vs `University College London` |
| `Cat`, `Caterpillar` | — |

### Location Deduplication

Locations are the most reusable entities. You MUST search before creating:

| Source Says | Search For |
|-------------|------------|
| `NYC` | `New York, USA` |
| `London, England` | `London, UK` |
| `San Francisco, California` | `San Francisco, USA` |

---

## Document-Type Entity Expectations

When extracting from different source types, expect to create these entity mixes. Use this as a completeness check — if you extract a LinkedIn profile and produce zero Organization entities, something is wrong.

| Source Type | Primary Entities | Also Creates | Minimum Relationships |
|-------------|-----------------|--------------|----------------------|
| **LinkedIn profile** | Person, Organization | Location, Event (job changes, education) | 1 WORKS_AT per job, 1 STUDIED_AT per school, 1 LIVES_IN |
| **Team directory** | Person (many), Organization | Location | 1 WORKS_AT per person |
| **CV / Resume** | Person, Organization (many) | Location, Event (career milestones) | 1 WORKS_AT per role, 1 STUDIED_AT per qualification |
| **Social media bio** | Person | Organization, Location | At least 1 WORKS_AT or MEMBER_OF |
| **Meeting notes** | Person (stubs) | Organization (stubs) | KNOWS between participants |
| **Obituary** | Person, Event | Location, Organization | EXPERIENCED for death event, IS_RELATED_TO for family |
| **Conference attendee list** | Person (many stubs) | Organization (many stubs) | WORKS_AT for each person-org pair |

**Stubs are expected and useful.** A Person entity with just a name and organization is better than no entity at all. You MUST create stub entities for every named person and organization, even those mentioned only once.

---

## Anti-Hallucination Rules

These rules exist because extraction models have been observed fabricating plausible-sounding values that are not in the source data. Violations of these rules are extraction failures.

### Rule 1: If the source doesn't state it, OMIT the property entirely

Do NOT fill in values you "know" from general knowledge. You MUST leave the property out if the source text does not explicitly state it.

| Property | Hallucination Example | Why It's Dangerous |
|----------|-----------------------|--------------------|
| `dateOfBirth` | Inserting a birth year for a public figure | The model "knows" the date but it may be wrong or not in the source |
| `email` | Generating `first.last@company.com` | The address may not exist — fabricated contact info is harmful |
| `nationality` | Inferring from name or location | Names and locations don't reliably indicate nationality |
| `coordinates` | Adding lat/long for a well-known city | May be imprecise or wrong for the specific location referenced |
| `phone` | Generating a plausible phone number | Fabricated phone numbers could belong to real people |
| `website` | Constructing a URL from the company name | The URL may not exist or may belong to a different entity |

**Test:** For every property value, ask: "Can I point to the exact text in the source that states this?" If no, OMIT the property.

### Rule 2: Don't infer relationship types beyond what the source states

| Source Says | Correct | Wrong |
|-------------|---------|-------|
| "Alice and Bob work at the same company" | `WORKS_AT` for both → Company | `IS_FRIENDS_WITH` (not stated) |
| "Alice reports to Bob" | `MANAGES` (Bob → Alice) | `IS_FRIENDS_WITH` (not stated) |
| "Alice met Bob at a conference" | `KNOWS` with context | `IS_FRIENDS_WITH` (not stated) |
| "Alice and Bob are colleagues" | `WORKS_AT` for both → same org, plus `KNOWS` | `IS_FRIENDS_WITH` (not stated) |

**ZERO TOLERANCE for relationship type upgrades.** Do NOT upgrade `KNOWS` to `IS_FRIENDS_WITH` unless the source explicitly describes a friendship. Do NOT infer `IS_PARENT_OF` from surnames alone. Do NOT infer `MANAGES` from seniority differences.

### Rule 3: Don't merge distinct people

When a source mentions "John Smith" in two different contexts without making it clear they are the same person, you MUST create two separate entities. It is far easier to merge duplicates later than to untangle incorrectly merged identities.

**Signals that two references are the same person:**
- Same full name AND same organization
- Explicit cross-reference ("John Smith, mentioned earlier...")
- Unique identifying details match (email, role + company)

**Signals that two references may be different people:**
- Same name but different organizations
- Same name but different time periods with no continuity
- Common name without additional identifying details

### Rule 4: Don't fabricate dates or date precision

If the source says "Alice joined in 2021", use `startDate: "2021"`. Do NOT fabricate `startDate: "2021-01-01"`. January 1st is a hallucination pattern — models default to it when only the year is known.

| Source Says | Correct | Wrong |
|-------------|---------|-------|
| "joined in 2021" | `2021` | `2021-01-01` |
| "graduated in June" | `2024-06` (if year is contextually clear) | `2024-06-01` |
| "has been there for years" | Omit date entirely | `2019` (guessed) |

### Rule 5: Don't infer organizational hierarchy

If the source mentions "Google" and "Alphabet" without stating a parent-subsidiary relationship, create them as separate Organization entities with no relationship between them. Do NOT add organizational hierarchy relationships from general knowledge.

### Rule 6: Don't fabricate summaries beyond source content

Entity summaries MUST be derived from the source text. If the source says "Alice is a software engineer at Acme", the summary should reflect that — not "Alice is a talented software engineer with a passion for clean code at Acme" or other embellishments.

---

## Extraction Error Patterns

These are errors observed in real extraction runs on person-domain documents. Check your output against each pattern.

### 1. Orphan relationships from label drift

**Error:** Relationship uses a name variant that doesn't match any entity label.

| Entity Label | Relationship sourceLabel | Problem |
|-------------|------------------------|---------|
| `Alice Johnson` | `Alice` | First name only — orphan |
| `Alice Johnson` | `Dr. Alice Johnson` | Title included — orphan |
| `Imperial College London` | `Imperial College` | Abbreviated — orphan |
| `London, UK` | `London` | Missing qualifier — orphan |

**Fix:** After creating all relationships, verify every sourceLabel and targetLabel has an exact entity match.

### 2. Missing organization entities for employment mentions

**Error:** A `WORKS_AT` relationship references an organization that was never created as an entity. This happens when the model treats the organization as a property of the person rather than a separate entity.

**Fix:** Every organization named in a WORKS_AT, STUDIED_AT, MEMBER_OF, or FOUNDED relationship MUST exist as an Organization entity.

### 3. Collapsed career history

**Error:** A person with three jobs produces only one `WORKS_AT` relationship (usually the most recent). Past employment is mentioned in the summary but not as separate relationships.

**Fix:** Follow the decomposition rules. Each distinct employment MUST be a separate `WORKS_AT` with its own dates and role.

### 4. Bidirectional relationship duplication

**Error:** Creating `KNOWS` from Alice → Bob AND from Bob → Alice. Or creating `IS_MARRIED_TO` in both directions.

**Fix:** `KNOWS`, `IS_FRIENDS_WITH`, `IS_RELATED_TO`, and `IS_MARRIED_TO` are bidirectional. Create them ONCE in one direction only.

### 5. Events without person links

**Error:** An Event entity is created (e.g., "graduation: BSc Computer Science") but no `EXPERIENCED` or `INVOLVED_IN` relationship connects it to a Person.

**Fix:** Every Event MUST have at least one Person link. An Event with no Person link cannot be discovered through graph traversal and is an extraction failure.

### 6. Location entities without relationships

**Error:** A Location entity is created but no `LIVES_IN`, `BORN_IN`, `LOCATED_IN`, or `OCCURRED_AT` relationship references it.

**Fix:** Every Location entity MUST be referenced by at least one relationship. If a location is mentioned only in narrative context (not connected to a person, organization, or event), it should go in a summary, not as a standalone entity.

### 7. Bare relationships with no properties

**Error:** A `WORKS_AT` relationship with no `role`, no `startDate`, no properties at all. A `KNOWS` with no `context`.

**Fix:** Every relationship MUST include all properties that the source provides. Minimum properties by type:

| Relationship | Minimum Properties |
|--------------|-------------------|
| `WORKS_AT` | `role`, `startDate` |
| `STUDIED_AT` | `qualification` or `field`, `startDate` or `endDate` |
| `KNOWS` | `context` |
| `IS_RELATED_TO` | `relation` (required by vocabulary) |
| `LIVES_IN` | `startDate` |
| `MEMBER_OF` | `role` |

### 8. Organization type defaulting

**Error:** Every Organization gets `orgType: "company"` regardless of context.

| Entity | Correct `orgType` | Wrong `orgType` |
|--------|-------------------|-----------------|
| "Google Engineering" (a department) | `team` | `company` |
| "IEEE" | `association` | `company` |
| "Stanford University" | `university` | `company` |
| "NHS" | `government` | `company` |
| "Code First Girls" | `non-profit` | `company` |
| "Richmond Cricket Club" | `club` | `company` |

**Fix:** Read the source context to determine the organization type. Default to `company` only when the source clearly describes a commercial entity.

---

## Person Domain Terminology

Key terms that affect extraction decisions. When you encounter these in source text, apply the extraction impact described.

| Term | Meaning | Extraction Impact |
|------|---------|-------------------|
| **Stub entity** | An entity with minimal properties (often just a label) | You MUST create stubs for every named person/org — don't skip entities because you lack detail |
| **Compound surname** | A multi-part family name (e.g. Garcia Lopez) | Never drop parts of compound surnames — the full surname is the label |
| **Bidirectional relationship** | A relationship traversable in both directions | Create ONCE only — KNOWS, IS_FRIENDS_WITH, IS_RELATED_TO, IS_MARRIED_TO |
| **Temporal relationship** | A relationship with start/end dates | Use startDate/endDate properties — never delete relationships to represent time |
| **Orphan relationship** | A relationship referencing a non-existent entity | An extraction failure — always verify labels match |
| **Progressive context** | Entity labels carried forward from prior chunks | Reuse labels from progressive context to prevent duplicates across chunks |
| **Role change** | A promotion or lateral move within the same organization | Produces TWO WORKS_AT relationships: one ending, one starting |
| **Affiliation** | Non-employment connection (board, club, volunteer) | Use MEMBER_OF, not WORKS_AT — these are distinct relationship types |
| **Honorific** | Title prefix (Dr., Prof., Sir) | NEVER include in entity labels — goes in summary or properties |
| **Alias** | An alternate name for the same entity | Use update_entity to add — never create a second entity for an alias |
| **Entity label** | The canonical name used to identify an entity | Must be consistent across all documents — this is what relationships reference |
| **Qualification** | A degree, diploma, or certification | Always include on STUDIED_AT relationships when stated in source |
