# Creating Custom Starter Kits for the Indexing Pipeline

This guide covers how to build a starter kit that configures the deep-memory indexing pipeline for a specific domain. A starter kit is a small set of files that define the vocabulary, extraction guidance, and validation rules the pipeline (or an AI agent doing manual indexing) uses to populate a knowledge graph from source documents.

---

## What is a Starter Kit

A starter kit is a directory containing 3-5 files that configure the indexing pipeline for a specific domain. Each kit lives at:

```
index-starterkits/{domain-name}/
```

The files are consumed directly by the automated indexing pipeline and by AI agents performing manual indexing via MCP tools. They answer three questions:

1. **What to extract** -- the vocabulary (entity types, relationship types, property schemas).
2. **How to extract it** -- domain guidance injected into the LLM prompt (naming rules, deduplication logic, anti-hallucination rules).
3. **In what order** -- the indexing strategy (document types, phased extraction, model recommendations).

### File inventory

| File | Required | Purpose |
|------|----------|---------|
| `vocabulary.md` | yes | Entity types, relationship types, property schemas |
| `domain-guidance.md` | yes | Extraction prompt guidance for LLM agents |
| `README.md` | yes | Overview, use cases, manual indexing process |
| `indexing-strategy.md` | no | Document-type-specific extraction patterns and phased approach |
| `validation-rules.json` | no | Machine-readable property ranges and structural constraints |

The three required files are sufficient for most domains. The two optional files add value for complex domains with multiple document types or strict validation needs. Of the five existing kits, only `mining/` uses all five files; the other four (`council/`, `legal/`, `person/`, `conversations/`) use the three required files.

---

## File-by-File Guide

### vocabulary.md (required)

The vocabulary file defines every entity type and relationship type the pipeline should recognize. It is the canonical reference for the domain's data model -- both the automated pipeline and human reviewers read it.

#### Structure

Start with a **Patterns** section (5-7 numbered conventions) that explain the design philosophy before the reader encounters the full type definitions. This section should cover:

- How entities relate to each other (hierarchy patterns, shared entities)
- Whether relationships carry operational data in properties
- What goes on entities vs relationships vs separate entity types
- Whether type values are enums or open recommendations
- Label and summary conventions

Then define each entity type and each relationship type.

#### Entity type definition format

For each entity type, provide:

1. **A description** -- one paragraph explaining what the type represents and when to use it.
2. **A property table** with columns: Property, Type, Required, Description.
3. **Label convention** -- a format string showing how labels should be constructed.
4. **Summary convention** -- guidance on what to include in the summary field.
5. **Recommended values** (where applicable) -- a table of suggested values for classification properties like `equipmentType`, `orgType`, `eventType`, etc.

Example from the mining kit:

```markdown
### Equipment

A specific equipment model -- not an individual serial-numbered machine,
but a model that represents all machines of that type.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `modelNumber` | string | yes | Manufacturer's model designation |
| `equipmentType` | string | yes | See recommended values below |
| `operatingWeight` | string | no | With units (e.g. `682 MT`) |
| `enginePower` | string | no | Total rated power with units |

**Label convention:** `{Manufacturer} {modelNumber}` (e.g. "Komatsu PC7000-11").

**Summary convention:** A one-line description including type, class, and
key capability.

**Recommended `equipmentType` values:**

| Value | Description |
|-------|-------------|
| `hydraulic-excavator` | Track-mounted hydraulic excavator |
| `haul-truck` | Off-highway rigid or articulated dump truck |
```

#### Relationship type definition format

Group relationship types by category (e.g., "Structural", "Operational", "Social"). For each type, provide:

1. **A summary table** with columns: Type, Description, Source -> Target, Bidirectional.
2. **A properties table** for each type that carries properties, with columns: Property, Type, Required, Description.

#### Naming conventions

- **Entity types:** PascalCase (`Equipment`, `MaintenanceProcedure`, `OperationalContext`).
- **Relationship types:** SCREAMING_SNAKE_CASE (`HAS_COMPONENT`, `REQUIRES_FLUID`, `COMPATIBLE_WITH`). The core library normalizes relationship types to this format automatically, but define them in this casing for clarity.
- **Property names:** camelCase (`operatingWeight`, `bucketCapacity`, `changeInterval`).
- **Recommended values for classification properties:** kebab-case (`hydraulic-excavator`, `engine-oil`, `get-tooth`).

#### Governance mode recommendation

Include a governance mode recommendation at the top of the vocabulary or in the patterns section. The three modes are:

| Mode | Behavior | When to use |
|------|----------|-------------|
| `locked` | No vocabulary changes allowed | Production repositories with a finalized schema |
| `managed` | Changes require approval | Repositories where vocabulary changes need human review |
| `open` | Auto-approve with deduplication | Active indexing, exploratory domains, broad taxonomies |

Most starter kits recommend `open` governance because domain-specific terminology is too varied to anticipate fully upfront. The mining kit explains it this way: "Mining equipment terminology is extensive and highly varied across manufacturers, model generations, and regional conventions. The agent needs to create new vocabulary terms freely during indexing."

---

### domain-guidance.md (required)

The domain guidance file is injected into the LLM prompt during extraction. It provides the domain-specific knowledge that prevents extraction errors. The vocabulary tells the LLM *what* to extract; the domain guidance tells it *how to interpret what it reads*.

#### Sections to include

**1. Entity Naming Rules**

The most important section. Inconsistent entity labels are the primary cause of orphan relationships and duplicate entities. Define explicit naming rules for every entity type with correct/incorrect examples in table form.

From the mining kit:

```markdown
### Equipment Labels

**Format:** `{Full Manufacturer Name} {Model Number}`

| Correct | Incorrect |
|---------|-----------|
| `Caterpillar 325F L` | `Cat 325F L` |
| `Komatsu PC7000-11` | `PC7000-11` |
```

From the person kit:

```markdown
### Person Labels

**Format:** `{firstName} {lastName}`

| Correct | Incorrect |
|---------|-----------|
| `Alice Johnson` | `A. Johnson` |
| `Robert Smith` | `Bob Smith` (unless "Bob" is the person's known name) |
```

Cover every entity type. Include edge cases that have caused real extraction errors.

**2. Relationship Referencing Rules**

A short, emphatic section stating that every `sourceLabel` and `targetLabel` in a relationship must exactly match an entity label. Include a concrete example of what goes wrong when this rule is violated (orphan relationships).

**3. Domain-Specific Knowledge**

The knowledge that helps the LLM interpret source documents correctly. This varies by domain:

- Mining: model numbering systems (Cat `325F L`, Komatsu `PC7000-11`), equipment classification guide, weight type distinctions.
- Legal: clause type identification, party role disambiguation, definition scope rules.
- Person: temporal relationship patterns (current vs past), deduplication by name variants.

**4. Document-Type Entity Expectations**

A table mapping source document types to the entity types typically extracted from each. This sets expectations and helps the LLM identify when it is under-extracting.

**5. Anti-Hallucination Rules**

Explicit rules that prevent the LLM from fabricating property values from general knowledge. Every kit should include these:

- Rule 1: If the source does not state a value, omit the property entirely.
- Rule 2: Do not add aliases from general knowledge.
- Rule 3: Keep per-configuration values separate (do not merge ranges).

Include domain-specific hallucination patterns -- the property values the LLM is most likely to fabricate in this domain.

**6. Common Extraction Pitfalls**

Numbered list of patterns that consistently produce errors in this domain. Each pitfall should include:

- Description of the problem.
- The rule to follow.
- An example if possible.

**7. Domain Terminology** (optional)

A glossary of domain-specific abbreviations and terms that the LLM may encounter, with their impact on extraction decisions.

#### Entity creation ordering

Define a dependency order for entity creation. Entities that are referenced by other entities should be created first. Every kit needs this, though the complexity varies:

- Simple domains: "Create Locations first, then Organizations, then People, then Events."
- Complex domains: "Create Manufacturers first, then Fluids, then Equipment, then Components, then Parts, then all relationships in dependency order."

The ordering prevents forward references -- relationships that point to entities that do not exist yet.

#### Deduplication rules per entity type

For each entity type, define:

- The unique key (which properties identify a duplicate).
- Match criteria (case-insensitive, strip whitespace, etc.).
- Action when a match is found (skip creation, enrich existing entity).

Example from the mining kit:

```markdown
| Entity Type | Unique Key | Match Criteria |
|-------------|-----------|-----------------|
| Equipment | `(modelNumber, manufacturer)` | Case-insensitive exact match |
| Fluid | `(specification, standard)` | Match by specification first |
| Part | `partNumber` | Exact match on part number string |
```

---

### indexing-strategy.md (optional)

The indexing strategy file provides document-type-specific extraction patterns and a phased approach to indexing. It is most valuable for complex domains with multiple source document types (e.g., spec sheets, manuals, handbooks in the mining domain). Simple domains that index a single document type may not need this file.

#### Sections to include

**1. Extraction Accuracy Rules**

The most critical rules that override all other guidance. These are typically stronger versions of the anti-hallucination rules from domain-guidance.md, with domain-specific examples of common errors.

**2. Document Types and What to Extract**

For each source document type:

- Description and characteristics.
- What to extract: a table mapping source content to entity types and priority levels (Critical, High, Medium, Low).
- Granularity guidance: how deep to go, when to create stubs vs full entities.
- Expected yield: approximate entity and relationship counts per document.

**3. Phased Extraction Approach**

Define 2-4 phases, each building on the previous:

- Phase goal and deliverable.
- Which documents to index in this phase.
- Model recommendation (e.g., Haiku for structured tables, Opus for prose interpretation).
- Verification checkpoint: what to check before moving to the next phase.

The phased approach works because later documents enrich entities created in earlier phases rather than creating from scratch.

**4. Decision Trees for Common Ambiguities**

Q&A format addressing the judgment calls that come up during extraction. Example:

```markdown
**Q: Is this a new Component or enrichment of an existing one?**
A: Within the same Equipment, check componentType + location.
   If match found, enrich. If not, create.

**Q: Should I create a Part or a sub-Component?**
A: If the spec sheet provides a part number, create Part.
   If it provides a model number and specifications, create Component.
```

**5. Extraction Verification Checkpoints**

A table of checks to run after extracting from each document type. These catch under-extraction before it compounds in later phases.

**6. Granularity Decision Guide**

A table of questions to ask when deciding whether to create an entity or capture data as a property:

```markdown
| Question | Go Deeper | Keep It Simple |
|----------|-----------|----------------|
| Would a user search for this? | Create entity | Capture as property |
| Is this shared across multiple parents? | Shared entity + relationships | Property on parent |
```

---

### validation-rules.json (optional)

A machine-readable file defining property ranges, enum constraints, and structural rules. The validation rules are used by the pipeline to catch extraction errors before they enter the repository.

#### Structure

```json
{
  "version": "1.0.0",
  "domain": "your-domain-name",
  "propertyRanges": {
    "EntityType": {
      "propertyName": {
        "type": "number",
        "unit": "kW",
        "min": 10,
        "max": 5000
      }
    }
  },
  "relationshipRanges": {
    "RELATIONSHIP_TYPE": {
      "propertyName": {
        "type": "integer",
        "min": 2,
        "max": 8
      }
    }
  },
  "structuralRules": {
    "requiredRelationships": {
      "EntityType": ["RELATIONSHIP_TYPE"]
    },
    "noOrphans": true,
    "maxEntitiesPerExtraction": 200,
    "maxRelationshipsPerExtraction": 500
  }
}
```

#### Property range types

| Type | Fields | Purpose |
|------|--------|---------|
| `number` | `min`, `max`, `unit` | Continuous numeric values (weight, power, capacity) |
| `integer` | `min`, `max` | Whole number values (pass count, quantity) |
| `percentage` | `min`, `max` | Percentage values (fill factor, efficiency) |
| `string` | `enum: [...]` | Constrained string values |

#### Structural rules

- `requiredRelationships`: for each entity type, which relationship types must exist. Example: every Equipment entity must have at least one `MANUFACTURED_BY` relationship.
- `noOrphans`: when `true`, every entity must have at least one relationship.
- `maxEntitiesPerExtraction` / `maxRelationshipsPerExtraction`: upper bounds per extraction batch to catch runaway extraction.

From the mining kit, a concrete example of how property ranges catch errors:

```json
"COMPATIBLE_WITH": {
  "passCount": { "type": "integer", "min": 2, "max": 8 }
}
```

This catches a common extraction error where the LLM confuses Y-axis tonnage values (100-300) with actual pass counts (3-7) when interpreting flattened chart data.

---

### README.md (required)

The README is the entry point for anyone using the starter kit. It serves both human developers and AI agents.

#### Sections to include

**1. Purpose**

One paragraph explaining what the kit is for and what domain it covers. State whether it is standalone or extends another kit.

**2. Target Use Cases**

Bulleted list of the specific queries and workflows the knowledge graph will support once populated.

**3. What the Graph Can Answer**

Concrete example questions in natural language. These double as acceptance criteria -- if the populated graph cannot answer these questions, the indexing is incomplete.

**4. When to Use This Kit**

Criteria for choosing this kit over alternatives.

**5. Governance Recommendation**

Which governance mode to use and why.

**6. Starter Kit Files**

Table listing the files in the kit with one-line descriptions.

**7. Automated Extraction**

Brief note that the vocabulary and domain guidance files are consumed by the pipeline automatically, with a link to the indexer extraction guide.

**8. Manual Indexing Process (MCP Tools)**

Step-by-step instructions for indexing using MCP tools directly (for cases where the automated pipeline is not used). This should include:

- Prerequisites.
- Numbered steps matching the entity creation ordering from domain-guidance.md.
- Deduplication reminders at each step.
- A verification section at the end with specific checks.

**9. Worked Example** (recommended for complex domains)

A concrete walkthrough showing the extraction of one source document into entities and relationships. The mining kit includes a detailed worked example that walks through indexing a single spec sheet, producing 66 numbered steps from manufacturer creation through final verification.

**10. Entity Type Reference Table** (optional)

A quick-reference table listing all entity types and their descriptions, separate from the full vocabulary.

**11. Relationship Type Reference Table** (optional)

A quick-reference table listing all relationship types, their source/target entity types, and whether they carry properties.

---

## Vocabulary Design Principles

These principles are drawn from practical experience building and iterating on the existing kits.

### Start broad, narrow through iteration

Your first vocabulary draft will not be perfect. Define the entity types and relationship types you expect to need, run a sample extraction against one source document, and examine what the LLM produced. The first extraction reveals:

- Entity types you forgot (common in domains with implicit categories).
- Properties you defined but that never appear in the source documents.
- Relationship types that the LLM had to invent because the vocabulary did not include them.

Refine the vocabulary based on what you learned, then extract again.

### Properties should be extractable from source documents

Do not add properties that require inference or external knowledge. If a property cannot be populated by reading a source document, it does not belong in the vocabulary.

Bad: `marketShare` on an Equipment entity (requires external business data).
Good: `operatingWeight` on an Equipment entity (stated on spec sheets).

Bad: `personality` on a Person entity (requires psychological assessment).
Good: `email` on a Person entity (stated in directories and profiles).

### Keep entity types orthogonal

Each entity should fit exactly one type. If an entity could plausibly be two types, the types overlap and should be redesigned.

Bad: `Machine` and `Vehicle` as separate types (a haul truck is both).
Good: `Equipment` with an `equipmentType` property that distinguishes machines and vehicles.

Bad: `Interest` and `Topic` as separate types (most interests are topics).
Good: `Interest` with a `category` property, or a single `Topic` type with an `INTERESTED_IN` relationship.

### Relationship types should have clear semantics

Avoid generic relationship types like `RELATED_TO` or `ASSOCIATED_WITH`. Every relationship type should answer a specific question:

- `HAS_COMPONENT` answers "what is this equipment made of?"
- `REQUIRES_FLUID` answers "what fluid does this component need?"
- `COMPATIBLE_WITH` answers "which equipment works with which?"
- `WORKS_AT` answers "where does this person work?"

If you find yourself reaching for `RELATED_TO`, it usually means you need a more specific relationship type or the connection should be modeled differently (e.g., as a property instead of a relationship).

### Include property descriptions -- they guide LLM extraction accuracy

The `Description` column in property tables is not just documentation. It is injected into the extraction prompt and directly influences what the LLM extracts. A vague description produces vague extractions.

Bad: `weight` -- "The weight." (LLM does not know which weight -- operating, shipping, dry?)
Good: `operatingWeight` -- "Operating weight including fuel, operator, and standard equipment. With units (e.g. `682 MT`)."

Bad: `date` -- "The date." (LLM does not know which date)
Good: `startDate` -- "ISO 8601 date when the relationship began. Omit for relationships active since the entity was created."

### Use the first extraction to discover missing entity types

After running the first extraction, review the output for:

- Entities that the LLM created with a type that does not exist in the vocabulary (these are candidates for new types).
- Properties that are overloaded -- a single property storing structured data that should be a separate entity.
- Relationships that point to entity types not in the vocabulary.

This is especially important in `open` governance mode, where the LLM can propose new types on the fly. Review what it proposed and decide whether to formalize those types in the vocabulary.

---

## Domain Guidance Writing Tips

### Be specific about what to extract and what to ignore

The LLM will attempt to extract everything it sees unless you tell it not to. Explicit "do not extract" rules are as important as "do extract" rules.

From the mining kit:
- "Do NOT index operating procedures as entities unless they contain maintenance-relevant information."
- "Safety warnings and legal disclaimers -- capture as a `safetyRequirements` property, not as separate entities."
- "Marketing claims -- 'industry-leading productivity' is not data. '5,000 t/hour at 1.8 t/m3 density' is data."

### Include examples of good vs bad entity labels

Tables of correct/incorrect labels are the single most effective tool for preventing extraction errors. The LLM pattern-matches on these examples, so include 4-6 examples per entity type covering the most common mistakes.

### Address known misinterpretation patterns

Source documents often contain structures that LLMs consistently misinterpret:

- **Charts flattened to text:** PDF-to-markdown conversion turns bar charts and scatter plots into confusing sequences of numbers. Explain what the numbers mean (axis labels vs data points vs tick marks).
- **Multi-model tables:** Tables that list specs for multiple models side by side. The LLM may merge values from different columns.
- **Abbreviated references:** Documents that use short forms after first mention ("the PC7000" after establishing "Komatsu PC7000-11"). The domain guidance should state which form to use in entity labels.
- **Implicit relationships:** "This system uses SAE 15W-40" -- the LLM needs to know to create both the Fluid entity and the REQUIRES_FLUID relationship, not just note it as a property.

### Keep it under approximately 2000 words

Domain guidance is injected into every extraction prompt. A 5000-word guidance document dilutes the signal -- the LLM has to process more context to find the relevant rules, and the rules it needs may fall outside its effective attention window.

If your domain guidance is growing beyond 2000 words, move document-type-specific content to `indexing-strategy.md` and keep domain-guidance.md focused on naming rules, deduplication, anti-hallucination, and domain terminology.

### Test with a sample extraction and refine based on results

Write the first draft, run one extraction, and review the output for:

1. Label inconsistencies (the naming rules were not clear enough).
2. Missing entities (the guidance did not tell the LLM to create stubs for relationship targets).
3. Fabricated property values (the anti-hallucination rules need more domain-specific examples).
4. Wrong entity types (the classification guidance was ambiguous).
5. Orphan relationships (the relationship referencing rules were not emphasized enough).

Revise the domain guidance to address each pattern you find. Two iterations is usually sufficient to get high-quality extractions.

---

## Existing Starter Kits as Reference

Five starter kits exist in `index-starterkits/` and serve as practical examples for different domain complexities.

### mining/

**Files:** vocabulary.md, domain-guidance.md, indexing-strategy.md, validation-rules.json, README.md (all 5 files)

The most comprehensive kit. Covers equipment, components, parts, fluids, maintenance procedures, failure modes, and operational contexts. Demonstrates:

- Deep component hierarchies (Equipment -> Component -> sub-Component -> Part).
- Shared entities across manufacturers (fluids, parts).
- Operational data on relationships (capacity, pass count, fill factor).
- Phased indexing strategy across three document types with different model recommendations.
- Detailed validation rules with property ranges and structural constraints.
- A worked example with 66 numbered extraction steps.

Use this kit as a reference when building vocabulary for a complex technical domain with multiple document types and deep entity hierarchies.

### council/

**Files:** vocabulary.md, domain-guidance.md, README.md

Covers local government planning -- zones, land use permissibility, development standards, signage rules, waterway structures, and community infrastructure. Demonstrates:

- Regulatory domain modeling (zones, standards, policies).
- Spatial and categorical relationships between zones and land uses.
- A domain where the source documents are regulatory instruments rather than technical specifications.

Use this kit as a reference when the domain involves regulatory frameworks, zoning, or policy-based knowledge.

### legal/

**Files:** vocabulary.md, domain-guidance.md, README.md

Covers contract knowledge -- parties, clauses, obligations, rights, definitions, and governance terms. Demonstrates:

- Document-structure modeling (a contract is composed of clauses; clauses have properties and cross-references).
- Obligation and rights tracking per party.
- Template comparison and deviation detection.
- A domain where the source documents are the entities themselves (the contract IS the knowledge, not a description of external knowledge).

Use this kit as a reference when the domain involves document-centric knowledge where the structure of the document matters as much as its content.

### person/

**Files:** vocabulary.md, domain-guidance.md, README.md

Covers people and their relationships -- identity, social connections, employment, education, life events. Demonstrates:

- Simple, well-understood entity types (Person, Organization, Location, Event).
- Temporal relationships via startDate/endDate properties.
- Bidirectional relationship types (KNOWS, IS_FRIENDS_WITH).
- A vocabulary small enough to fit in a single screen.

Use this kit as a reference when building vocabulary for a simple relational domain with well-defined entity types and relationship semantics.

### conversations/

**Files:** vocabulary.md, domain-guidance.md, README.md

Covers AI memory derived from conversations -- interests, preferences, goals, decisions, and contextual notes. Demonstrates:

- An extension vocabulary (designed to work alongside the person kit in the same repository).
- Entities that represent distilled knowledge rather than external objects.
- A domain where the source "documents" are conversation transcripts.
- Provenance-heavy design (every mutation is stamped with actor, timestamp, and conversation ID).

Use this kit as a reference when the domain involves capturing and structuring knowledge that emerges from interactions rather than from pre-existing documents.

---

## Quick-Start Checklist

When creating a new starter kit from scratch:

1. Create a directory at `index-starterkits/{domain-name}/`.
2. Draft `vocabulary.md` -- start with the entity types and relationship types you expect to need. Include property schemas, label conventions, and recommended values.
3. Draft `domain-guidance.md` -- write entity naming rules, relationship referencing rules, deduplication rules, and anti-hallucination rules. Keep it under 2000 words.
4. Draft `README.md` -- write the purpose, use cases, example questions, governance recommendation, and manual indexing process.
5. Run a sample extraction against one source document.
6. Review the extraction output for label inconsistencies, missing entities, fabricated values, and orphan relationships.
7. Revise all three files based on what you learned.
8. (Optional) Add `indexing-strategy.md` if you have multiple document types with different extraction patterns.
9. (Optional) Add `validation-rules.json` if you need machine-readable property ranges or structural constraints.
10. Run a second extraction and verify the improvements.
