# Entity Identity Pattern

## The Problem

Knowledge graphs frequently contain entities that share the same label. Two people named "John Smith", three buildings called "Unit 4", or multiple machines of the same model on a mine site. The natural label is identical, but they represent different real-world things.

Without a disambiguation mechanism:
- The indexer's consolidation merges same-type, same-label entities into one (dedup key is `{entityType}:{label}`)
- Progressive context treats same-label entities as duplicates across chunks
- The resulting graph contains a single entity with merged properties from unrelated real-world things

## The Solution: Identity Entities

An **Identity** entity is a separate node that holds the constants that make a real-world thing unique. It connects to its parent entity via an `IS_IDENTITY_FOR` relationship.

### Example: Two People Named John Smith

**Without identity — broken:**
```
Person "John Smith" — properties merged from two different people. Useless.
```

**With identity — correct:**
```
Node 1 (Person):
  id: '19817f5f-546d-4fb9-871b-f597c44471a9'
  slug: 'person:john-smith (612d086e-9f65-484d-abd6-4ff3822ff960)'

Node 2 (Identity):
  id: '612d086e-9f65-484d-abd6-4ff3822ff960'
  slug: 'identity:john-smith (612d086e-9f65-484d-abd6-4ff3822ff960)'
  firstName: 'John'
  lastName: 'Smith'
  middleName: 'Albert'
  dateOfBirth: '2000-01-30'
  birthCountry: 'New Zealand'

Edge: IS_IDENTITY_FOR from Identity → Person

---

Node 3 (Person):
  id: 'c3d4e5f6-...'
  slug: 'person:john-smith (a1b2c3d4-...)'

Node 4 (Identity):
  id: 'a1b2c3d4-...'
  slug: 'identity:john-smith (a1b2c3d4-...)'
  firstName: 'John'
  lastName: 'Smith'
  middleName: 'David'
  dateOfBirth: '1975-08-15'
  birthCountry: 'United Kingdom'

Edge: IS_IDENTITY_FOR from Identity → Person
```

Each Person participates in relationships (WORKS_AT, LIVES_IN, etc.) as before. The Identity node anchors uniqueness.

## Slug Construction

The Identity GUID is embedded in both slugs:

- **Identity slug:** `identity:{slugified-label} ({own-guid})`
- **Parent entity slug:** `person:{slugified-label} ({identity-guid})`

This makes slugs globally unique regardless of label collisions. The slug is designed for **AI predictability** — an agent that created the Identity knows its GUID and can construct the parent slug deterministically.

## Relationship Type

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `IS_IDENTITY_FOR` | Links an Identity to the entity it uniquely identifies | Identity → Entity | no |

No special properties required. The relationship exists solely to connect the identity anchor to its parent entity.

## When to Use Identity

**The heuristic:** Can two real-world instances of this entity type reasonably share the same label?

| Answer | Action | Examples |
|--------|--------|----------|
| **Yes** — labels are not globally unique | Identity required | People (names collide), individual physical assets (machines, buildings) |
| **No** — labels are inherently unique | No identity needed | Equipment models (Cat 793F), legal clauses (section numbers), planning zones |

### Decision by Domain

| Domain | Entity Type | Identity? | Reasoning |
|--------|------------|-----------|-----------|
| **Person** | Person | Yes | Many people share names — firstName + lastName is not globally unique |
| **Person** | Organization | No | Organization names are typically unique; edge cases handled with label qualifiers |
| **Person** | Location | No | Solved with label qualifiers (London, UK vs London, Ontario) |
| **Mining** | Equipment (model/type) | No | Model designations like "Cat 793F" are globally unique |
| **Mining** | Vehicle (individual machine) | Yes | Multiple machines of the same model on a site — serial number is the identity |
| **Council** | Zone, Provision, etc. | No | Zone codes and provision references are unique within a planning scheme |
| **Legal** | Contract, Clause, etc. | No | Contract labels include party names; clauses are identified by section numbers |
| **Conversations** | Topic, Preference, etc. | No | Topics are canonical phrases; preferences include subject and position |

## Identity Properties Are Domain-Specific

The Identity entity type is generic, but its properties vary by domain. Each domain vocabulary declares which properties belong on its Identity entities.

| Domain | Identity Properties | What makes it unique |
|--------|--------------------|-----------------------|
| Person | firstName, lastName, middleName, dateOfBirth, birthCountry | Biographical constants that don't change |
| Fleet/Vehicle | serialNumber, registrationNumber, equipmentType | Manufacturer-assigned identifiers |
| Building/Unit | address, lotNumber, planNumber | Physical location and legal description |

## Extraction Workflow

When a domain uses identity, the LLM extraction flow becomes:

1. **Create Identity entity** — populate with whatever constants the source provides
2. **Create the parent entity** (e.g., Person) — label, summary, and graph-participation properties
3. **Create IS_IDENTITY_FOR relationship** — Identity → parent entity
4. **Attach all other relationships to the parent entity** — WORKS_AT, LIVES_IN, etc. connect to Person, not Identity

The Identity node is an anchor, not a graph participant. Queries traverse through the parent entity. The Identity exists to:
- Make the parent entity's slug globally unique
- Give the consolidator structured fields to compare when deciding whether to merge
- Accumulate disambiguating facts over time as more documents are processed

### Every Instance Gets an Identity

When a domain uses identity for an entity type, **every instance** of that type gets an Identity node — not just those with known collisions. This is because:
- The LLM doesn't need conditional logic ("is there a collision? if so, create identity...")
- Every slug is unique from creation, not retroactively patched
- The Identity node is always there to accumulate facts into, even if it starts sparse

## Sparse Identities Are Expected

Not every source document provides rich biographical data. An identity may start with just a name:

```
Identity (id: 612d086e...)
  firstName: John
  lastName: Smith
```

As more documents are processed, the identity accumulates:
- Document 2 adds middleName: Albert
- Document 5 adds dateOfBirth: 2000-01-30
- Document 8 adds birthCountry: New Zealand

Sparse identities are the normal starting state, not a problem to solve.

## Consolidation Behaviour

With identity nodes, the consolidator can make better merge decisions:

| Scenario | Without Identity | With Identity |
|----------|-----------------|---------------|
| Two "John Smith", different DOBs | Merged — data loss | Kept separate — DOBs conflict |
| Two "John Smith", identical properties | Merged — correct | Merged — correct |
| Two "John Smith", no distinguishing info | Merged — risky | Merged — acceptable (no evidence they differ) |

When both identities are sparse with no conflicting properties, the consolidator merges as before. The pattern only prevents false merges when disambiguating information actually exists and conflicts. This is the right trade-off — if the source provides no evidence that two same-name entities are different, merging is the safer default.

## Graph Queries

The Identity node should be transparent to most queries. When a user asks "tell me about John Smith", the query:
1. Finds the Person entity
2. Traverses IS_IDENTITY_FOR (inbound) to get biographical constants
3. Traverses WORKS_AT, LIVES_IN, etc. (outbound) for graph relationships
4. Combines the results

The identity layer adds one hop but provides the foundation for correct disambiguation.

## Reference Implementation

The person domain starter kit (`index-starterkits/person/`) provides the reference implementation of the identity pattern. See:
- `vocabulary.md` — Identity entity type definition and IS_IDENTITY_FOR relationship
- `domain-guidance.md` — Extraction rules for person identity
