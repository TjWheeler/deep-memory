# Council Planning Domain Starter Kit

## Purpose

This starter kit defines a vocabulary and indexing process for capturing **local government planning knowledge** — the zones, land use permissibility, development standards, signage controls, waterway structure rules, and community infrastructure requirements that make up a council's planning framework. It is designed around statutory planning schemes, local planning policies, and community infrastructure strategies as source material.

This is a **standalone vocabulary** — it does not depend on or extend other starter kits.

## Target Use Cases

- **Development permissibility** — determining what land uses are permitted, discretionary, or prohibited in each zone
- **Development standards lookup** — finding setbacks, height limits, density codes, and other measurable standards for a given zone and density
- **Signage compliance** — identifying which signs are exempt from approval and what conditions apply
- **Waterway structure rules** — determining what jetties, moorings, and boat lifts are permitted in specific canal estates
- **Community infrastructure planning** — identifying what facilities are required at each population tier
- **Policy override tracking** — understanding where local planning policies modify scheme standards
- **Precinct-specific rules** — finding special provisions that apply in heritage areas, canal estates, or activity centres

## What the Graph Can Answer

Once populated, an agent can answer questions like:

- "Can I build a shop in the Residential zone?"
- "What is the primary street setback for R20 density?"
- "Do I need development approval for an awning sign?"
- "Can I build a jetty in Southport Canals?"
- "What mooring types are available at Mandurah Ocean Marina?"
- "What community facilities are needed for a population of 20,000?"
- "What are the maximum dimensions for an outbuilding on my lot?"
- "Does the local planning policy modify the scheme setback for my density code?"
- "What special rules apply in the Apollo Place Heritage Area?"
- "What is the maximum height for a pylon sign?"
- "Which land uses require advertising before council can approve them?"
- "What is the canal wall setback in Port Mandurah Stage 1?"
- "What are the parking requirements for a restaurant in the District Centre zone?"

## When to Use This Kit

Use this starter kit when:

- You are indexing **local government planning schemes** to enable structured querying of land use and development rules.
- You want to build a **planning assistant** that can answer development feasibility questions.
- You need to **track the interaction between schemes, policies, and precinct-specific provisions** across a council's planning framework.
- You are building a **community infrastructure planning tool** based on population-driven facility requirements.

## Governance Recommendation

**`open`** governance is recommended. Council planning terminology varies significantly across jurisdictions — zone names, use classes, and development standards differ between councils and states. The agent needs to create new vocabulary terms on the fly without approval gates slowing down the indexing flow.

## Design Philosophy

**Model rules, not document layout.** The goal is not to reproduce the planning scheme text verbatim — that belongs in a document store. The graph captures the *regulatory structure*: what zones exist, what uses they permit, what standards apply, and how provisions from different instruments interact. The provision text is stored as a `content` property, but the value comes from the relationships.

**Provisions are the atomic unit.** A single scheme section may establish setbacks, heights, and parking in one paragraph. Each distinct rule becomes its own `Provision` entity so that queries can target individual standards without parsing compound rules.

**Permissibility is a first-class relationship.** The zone-to-land-use permissibility matrix is the most-queried part of any planning scheme. Modeling it as `PERMITS` relationships with a `permissibility` property (P/D/A/X) makes development feasibility a graph traversal, not a document search.

**Location-specific rules are precincts, not exceptions.** Heritage areas, canal estates, and special character areas aren't "exceptions to the rules" — they're legitimate planning contexts with their own provisions. The `Precinct` entity and `APPLIES_IN_PRECINCT` relationship make these discoverable and queryable.

---

## Starter Kit Files

| File | Description |
|------|-------------|
| `vocabulary.md` | Entity type and relationship type definitions for the council planning domain |
| `domain-guidance.md` | Extraction prompt guidance consumed by AI agents during indexing |
| `README.md` | This file — overview, automated extraction notes, and manual indexing guide |

---

## Automated Extraction

The `vocabulary.md` and `domain-guidance.md` files are consumed by the indexing pipeline automatically. When you configure an indexing job that targets this starter kit, the pipeline reads both files to guide LLM extraction — no manual prompt engineering is required.

See the [Indexer Extraction Guide](../../docs/indexer-extraction-guide.md) for configuration details including chunk sizing, output token limits, and model selection.

---

## Manual Indexing Process (MCP Tools)

Step-by-step guidance for an AI agent indexing council planning documents into a deep-memory repository using the Council vocabulary via MCP tools rather than the automated pipeline.

---

### Prerequisites

- Read `vocabulary.md` in this folder to understand the available entity types and relationship types before proceeding.
- Ensure the MCP server is running and accessible.
- Have the planning document available (text, PDF extract, or structured data).
- Identify whether this document is a scheme, policy, or strategy — this determines the `instrumentType`.

---

### Indexing Order

Always follow this sequence. Later steps depend on entities created in earlier steps.

1. Create the `PlanningInstrument`
2. Create `Zone` entities (if the document defines zones)
3. Create `Reserve` entities (if the document defines reserves)
4. Create `LandUse` entities and `PERMITS` relationships
5. Create `DensityCode` entities (if the document defines R-Code standards)
6. Create `Precinct` entities (if the document names special areas)
7. Create `StructureType` entities
8. Create `Provision` entities and link to instrument, zones, densities, precincts, and structures
9. Create `HierarchyLevel` and `CommunityFacility` entities (if applicable)
10. Create inter-provision relationships (overrides, cross-references)
11. Validate and verify the graph

---

### Step 1 — Create the Planning Instrument Entity

1. Create a `PlanningInstrument` entity with:
   - `instrumentType` — identify from the document (e.g. `local-planning-scheme`, `local-planning-policy`)
   - `status` — `operative` for current instruments, `superseded` for historical
   - `title` — the full official title
   - `referenceNumber` — official reference if stated (e.g. "LPS12", "LPP4")
   - `effectiveDate` — parse from the document
   - `jurisdiction` — the local government area
   - `administeredUnder` — parent legislation (e.g. "Planning and Development Act 2005")
   - `description` — a plain-language one-sentence summary

2. If this is a policy adopted under a scheme, search for the parent scheme entity and create a `SUBORDINATE_TO` relationship.

3. Note the entity ID — all provisions will reference it via `CONTAINS_PROVISION`.

---

### Step 2 — Create Zone Entities

For each zone defined in the document:

1. **Deduplicate first.** Search the repository for an existing zone with the same name before creating a new one.
2. Set `zoneType` from the recommended values.
3. Set `objectives` to the scheme's stated objectives for this zone.
4. Set development standard properties (`maxPlotRatio`, `maxBuildingHeight`, etc.) if stated at the zone level.

---

### Step 3 — Create Reserve Entities

For each reserve classification in the document:

1. Set `reserveType` from the recommended values.
2. Set `purpose` to the stated purpose.
3. Set `managedBy` if a responsible authority is identified.

---

### Step 4 — Create Land Use Entities and PERMITS Relationships

#### Creating Land Uses

1. **Deduplicate first.** Before creating a new LandUse, search for an existing entity with the same label.
2. Set `useClass` to the broad category.
3. Set `definition` to the scheme's statutory definition of this use.
4. Set `parking` to the parking standard if stated.

#### Linking Uses to Zones

For each zone-use combination in the permissibility table:
- Create a `PERMITS` relationship from Zone to LandUse
- Set `permissibility` to `P`, `D`, `A`, or `X`
- Set `conditions` if there are footnotes or qualifications

---

### Step 5 — Create Density Code Entities

For each R-Code with specific standards in the document:

1. Create a `DensityCode` entity with the code and key standards.
2. Create `CLASSIFIED_UNDER` relationships to each zone where this density applies.

---

### Step 6 — Create Precinct Entities

For each named area with special provisions:

1. Create a `Precinct` entity with `precinctType`, `location`, and `specialProvisions`.
2. Create `LOCATED_IN` relationships to the relevant zone(s).

---

### Step 7 — Create Structure Type Entities

For each regulated structure type:

1. Create a `StructureType` entity with `structureCategory`, dimensions, and approval requirements.
2. For signs, set `structureSubtype` to the specific sign type.
3. For jetties, set `structureSubtype` to the configuration type.

---

### Step 8 — Create Provision Entities and Relationships

This is the core extraction step. For each discrete rule or standard:

1. **One rule per entity.** Split compound sections into individual provisions.
2. Set `provisionType` from the recommended values.
3. Set `content` to the rule text or a faithful plain-language summary.
4. Set `sectionReference` to the section number in the source document.
5. Set `measureValue` and `measureUnit` for measurable standards.
6. Set `conditionText` for conditional provisions.
7. Set `exemptionText` for exemptions.

#### Linking Provisions

For each provision:
- Create `CONTAINS_PROVISION` from the PlanningInstrument
- Create `APPLIES_IN` to each applicable Zone
- Create `APPLIES_AT_DENSITY` to each applicable DensityCode
- Create `APPLIES_IN_PRECINCT` to each applicable Precinct
- Create `REGULATES` to each applicable StructureType
- Create `EXEMPTS` if the provision grants an exemption for a structure type
- Create `RESTRICTS` if the provision restricts a land use

---

### Step 9 — Create Community Infrastructure Entities

If the document establishes population-based facility requirements:

1. Create `HierarchyLevel` entities for each population tier.
2. Create `CommunityFacility` entities for each facility type (deduplicate across tiers).
3. Create `REQUIRES_FACILITY` from each HierarchyLevel to each required CommunityFacility.
4. Set relationship properties: `quantity`, `landSize`, `coLocate`, `priority`.

---

### Step 10 — Create Inter-Provision Relationships

1. **Overrides:** Where a policy provision modifies a scheme provision, create `OVERRIDES` from the policy provision to the scheme provision.
2. **Cross-references:** Where one provision explicitly references another, create `REFERENCES_PROVISION`.
3. **Instrument cross-references:** Where one planning instrument references another, create `REFERENCES_INSTRUMENT`.

---

### Step 11 — Validate and Verify

#### Structural Validation

1. **Instrument linkage** — every `Provision` must have a `CONTAINS_PROVISION` from a PlanningInstrument.
2. **Spatial linkage** — every `Provision` must have at least one of: `APPLIES_IN`, `APPLIES_AT_DENSITY`, or `APPLIES_IN_PRECINCT`.
3. **Permissibility coverage** — for each zone, count `PERMITS` relationships. If significantly fewer than the number of land uses, entries have been missed.
4. **Structure regulation** — every `StructureType` must have at least one `REGULATES` relationship from a Provision.
5. **No orphan entities** — every entity must participate in at least one relationship.

#### Neighborhood Exploration

Use `explore_neighborhood` (depth 2) on a Zone entity to confirm:
- Zone → LandUse (via `PERMITS`)
- Zone ← Provision (via `APPLIES_IN`)
- Zone ← DensityCode (via `CLASSIFIED_UNDER`)
- Zone ← Precinct (via `LOCATED_IN`)

#### Cross-Instrument Consistency

If multiple planning instruments have been indexed:
1. Check that `OVERRIDES` relationships exist where policies modify scheme standards.
2. Check that `SUBORDINATE_TO` relationships connect policies to their parent scheme.
3. Check that zone and land use entities are shared (not duplicated) across instruments.

---

### Example Indexing Sequence

Given the City of Mandurah's Local Planning Policy No. 4 — Canal Waterways Structures:

1. **Create PlanningInstrument:** "LPP4: Canal Waterways Structures", instrumentType: local-planning-policy, status: operative, effectiveDate: 2022-07-01
2. **Create SUBORDINATE_TO:** LPP4 → Local Planning Scheme No. 12
3. **Create Precinct:** "Port Mandurah Stage 1" (canal-estate)
4. **Create Precinct:** "Waterside Canals" (canal-estate)
5. **Create Precinct:** "Southport Canals" (canal-estate)
6. **Create Precinct:** "Mandurah Ocean Marina" (marina)
7. **Create StructureType:** "Finger Jetty" (jetty, structureSubtype: finger-jetty)
8. **Create StructureType:** "T-Shaped Jetty" (jetty, structureSubtype: t-shaped-jetty)
9. **Create StructureType:** "Mechanical Boat Lift" (boat-lifting-structure)
10. **Create StructureType:** "Mooring Pole" (mooring-pole, maxHeight: "2.0m AHD")
11. **Create Provision:** "Setback: 2.0m jetty setback to property boundary", provisionType: setback, measureValue: "2.0m"
12. **Create REGULATES:** Provision → "Finger Jetty"
13. **Create APPLIES_IN_PRECINCT:** Provision → "Port Mandurah Stage 1"
14. **Create Provision:** "Waterway control: Jetties prohibited in Southport Canals", provisionType: waterway-control
15. **Create APPLIES_IN_PRECINCT:** Provision → "Southport Canals"
16. **Create Provision:** "Setback: 4.0m minimum canal wall setback in Port Mandurah Stage 1", provisionType: setback, measureValue: "4.0m"
17. **Create APPLIES_IN_PRECINCT:** Provision → "Port Mandurah Stage 1"
18. **Create StructureType:** "Mooring Type A" (mooring-pole, maxLength: "6m vessel")
19. **Create StructureType:** "Mooring Type D" (mooring-pole, maxLength: "10m vessel, sail permitted")
20. **Create Provision:** "Waterway control: Mooring Type A for Precinct 1 and 2", provisionType: waterway-control
21. **Create APPLIES_IN_PRECINCT:** Provision → "Mandurah Ocean Marina"
22. **Validate:** Run neighborhood exploration on each Precinct to confirm provisions are linked; verify no orphan StructureType entities
