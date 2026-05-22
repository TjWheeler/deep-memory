# Council Planning Domain — Domain Guidance

This document provides domain-specific knowledge for AI agents extracting entities and relationships from local government planning documents. It supplements the vocabulary (what to extract) and the index process (how to extract) with knowledge about planning scheme conventions, policy interpretation, and common extraction errors.

This guidance is injected into the extraction prompt alongside the vocabulary. Follow it when making labeling, grouping, and relationship decisions.

---

## Identity Pattern

This domain does **not** use Identity entities. Zone codes, provision references, and planning instrument titles are unique within a planning scheme — there is no real-world ambiguity where two different zones or provisions share the same label. All entity types in this vocabulary are identified directly by their labels. See `docs/identity-pattern.md` for when identity is needed.

---

## MANDATORY Extraction Checklist

You MUST follow this checklist for every document. Do NOT skip steps. Incomplete extraction is a failure.

### Step 1: Identify the Planning Instrument
Create a `PlanningInstrument` entity for the source document. Set `instrumentType`, `status`, `title`, `referenceNumber`, and `effectiveDate`. If the document is a policy adopted under a scheme, create the parent scheme as a stub and link via `SUBORDINATE_TO`.

**Only create a PlanningInstrument entity for the document being indexed.** Documents listed in "Supporting Documents", "Related Documents", or "References" sections are bibliographic citations — do NOT create PlanningInstrument entities for them. The only exception is a parent instrument (e.g., the scheme a policy is adopted under), which should be created as a stub for the `SUBORDINATE_TO` relationship. If the document substantively references another instrument's specific provisions, use `REFERENCES_INSTRUMENT` from the source document's PlanningInstrument to a stub — but do not create stubs for every item in a bibliography list.

### Step 2: Extract ALL Zones (if present)
Create a `Zone` entity for EVERY zone defined in the document. Do not combine zones — each zone classification is a separate entity.

**Set only these Zone properties:** `zoneType`, `objectives`, `densityRange`, `maxBuildingHeight`, `maxPlotRatio`, `minLotSize`, `maxRetailFloorspace`, `description`. **All other development standards (setbacks, parking requirements, landscaping ratios, effective frontage, car parking ratios, boundary setbacks) MUST be created as Provision entities linked to this Zone via `APPLIES_IN`.** Do not invent Zone properties such as `primaryStreetSetback`, `sideSetback`, `rearSetback`, `minCarParking`, `minLandscaping`, `minEffectiveFrontage`, `minBoundarySetbacks`, or similar — these are always Provisions.

**Zones from operative provisions:** Also extract Zone entities from wherever a zone name appears in an operative provision, not only from dedicated zone definition sections. If a provision conditions an outcome on a named zone (e.g., "only in District Centre" or "all zones except Residential"), create a Zone entity stub even if the policy doesn't define it. The provision's spatial applicability depends on the zone being in the graph for `APPLIES_IN` relationships.

### Step 3: Extract ALL Land Use Permissibility
For every zone, extract the permissibility of each land use. Create `LandUse` entities (deduplicate — one entity per use, linked to multiple zones) and `PERMITS` relationships with the correct `permissibility` code (P, D, A, X).

### Step 4: Extract ALL Provisions — Decompose Aggressively
This is the most important step. Read every section and extract EVERY discrete rule or standard as a separate `Provision` entity. A single section often contains 2–5 separate provisions. You MUST create a separate Provision entity for each one.

**Decomposition signals — each of these creates a SEPARATE Provision:**
- A setback distance → one Provision (setback)
- A height limit → one Provision (height-limit)
- A lot size minimum → one Provision (lot-size)
- A parking standard → one Provision (parking)
- An exemption from approval → one Provision (exemption)
- A materials requirement → one Provision (with conditionText)
- A landscaping requirement → one Provision (landscaping)

**Decomposition boundaries — when NOT to split:**
- Sub-bullets that list *methods*, *options*, or *considerations* under a single policy direction are part of ONE Provision. Example: "acquire land through: (a) land swaps, (b) private acquisition, (c) retention" = one Provision. Similarly, "consider: population, location, size, quantity, cost" = one Provision with the criteria listed in `content`.
- Contextual footnotes, population projections, and background statistics are NOT Provisions.

**When TO split:** If a section has multiple *independent* numbered policy requirements that can each be assessed for compliance separately, each is a separate Provision. But do NOT split further within a single requirement.

**Assessment criteria sections:** When a section lists numbered criteria for assessing an application (e.g., "assessment criteria for boat lifting structures"), each numbered criterion is a separate Provision. If there are 6 criteria, create 6 Provisions. Use `measureValue`/`measureUnit` for numeric criteria and `content` with verbatim text for qualitative criteria. All Provisions in an assessment criteria section must have `REGULATES` linking to the relevant StructureType.

### Step 5: Extract ALL Structure Types
Create a `StructureType` entity for every built form that the document regulates — dwellings, outbuildings, signs, jetties, boat lifts, etc. Link via `REGULATES`. Do NOT create StructureType entities for land tenure categories (crown reserve, freehold land) or land use concepts (community purpose site, public open space) — these are definitions, not regulated structures.

### Step 6: Extract Density Codes (if present)
Create a `DensityCode` entity for every R-Code referenced with specific standards. Link to zones via `CLASSIFIED_UNDER` and to provisions via `APPLIES_AT_DENSITY`.

### Step 7: Extract Precincts (if present)
Create a `Precinct` entity for every named area that has its own special provisions differing from zone-wide standards. Link to zones via `LOCATED_IN` and to provisions via `APPLIES_IN_PRECINCT`. Named suburbs or localities where specific policy provisions apply (e.g., developing suburb acquisition strategies) are valid Precincts — use `precinctType: "development-area"`.

### Step 8: Extract Community Facilities and Hierarchy (if present)
Create `HierarchyLevel` and `CommunityFacility` entities if the document establishes population-based infrastructure requirements. Link via `REQUIRES_FACILITY`.

**REQUIRES_FACILITY accuracy:** Only create a `REQUIRES_FACILITY` relationship when the document explicitly states that a specific facility type is required at a specific hierarchy level (e.g., "District level requires a branch library"). A table that only shows population ranges and land sizes does NOT justify creating REQUIRES_FACILITY — it defines the tiers, not the facility mix. Do NOT infer that every facility type applies at every tier. This is a common hallucination.

### Step 9: Create ALL Relationships — This Is Critical
After extracting entities, you MUST create these relationships:

1. **For EVERY Provision:** Create a `CONTAINS_PROVISION` from the PlanningInstrument.
2. **For EVERY Provision that applies zone-wide:** Create an `APPLIES_IN` to each applicable Zone.
3. **For EVERY Provision that applies to a density:** Create an `APPLIES_AT_DENSITY` to each applicable DensityCode.
4. **For EVERY Provision that applies in a precinct:** Create an `APPLIES_IN_PRECINCT` to each applicable Precinct.
5. **For EVERY Provision that regulates a structure:** Create a `REGULATES` to each applicable StructureType.
6. **For EVERY LandUse in a zone:** Create a `PERMITS` with the correct permissibility code.
7. **For EVERY exemption:** Create an `EXEMPTS` from the exemption Provision to the StructureType.
8. **For cross-references between provisions:** Create `REFERENCES_PROVISION` or `OVERRIDES` as appropriate.

**⚠️ CRITICAL: Before writing ANY relationship, verify both endpoints exist in your entity list.**

If you are about to create `REGULATES → Boundary Wall`, check your entities: is there a `StructureType` with label `Boundary Wall`? If not, **create it first** — even as a minimal stub with just `structureCategory` (e.g., `retaining-wall` for a boundary wall, `patio-pergola` for a pergola, `fence` for a fence). The relationship cannot exist without both endpoints. Same rule applies to `PERMITS → LandUse`, `RESTRICTS → LandUse`, `EXEMPTS → StructureType`, `APPLIES_IN → Zone`, `APPLIES_IN_PRECINCT → Precinct`, and `APPLIES_AT_DENSITY → DensityCode`.

**Common trap:** the rule text talks about "boundary walls" or "front fences" or "pergolas" in the context of a setback/height provision, so you create the Provision — but forget to create the StructureType entity for the thing the provision regulates. This produces orphan relationships. **If a provision regulates a structure, BOTH the Provision and the StructureType must exist as entities.**

### Step 10: Verify Completeness
Before finishing, verify:
- Every Provision has a `CONTAINS_PROVISION` from a PlanningInstrument
- Every Provision has `content` set (the rule text or a faithful plain-language summary — NOT just the label)
- Every Provision has at least one spatial link (`APPLIES_IN`, `APPLIES_AT_DENSITY`, or `APPLIES_IN_PRECINCT`)
- **Every relationship's source and target labels match an entity you extracted.** Scan your relationship list; for each relationship, confirm both `sourceLabel` and `targetLabel` appear in your entity list. If a relationship targets an entity you haven't created (e.g. `REGULATES → Boundary Wall` but no `StructureType: Boundary Wall`), either create the missing entity or drop the relationship. **Orphan relationships are a validation failure.**
- Every Zone with land use permissibility has `PERMITS` relationships
- Every StructureType is linked to at least one `REGULATES` relationship
- No entity has a property outside its vocabulary definition (see Property Placement Rules below)
- Numeric-typed properties are numbers, not quoted strings (e.g., `"maxPlotRatio": 2.0` not `"2.0"`)
- No orphan entities exist without relationships

---

## Property Placement Rules — Quick Reference

If you are about to set a property that isn't listed in the vocabulary for that entity type, **STOP**. Create a Provision entity for that rule instead. Adding invented properties is the single largest source of extraction failure in this domain.

| Development Standard | Correct Entity | Correct Field or Relationship |
|---|---|---|
| Setback (primary street, secondary street, side, rear, boundary) | Provision | `measureValue` + `APPLIES_IN` / `APPLIES_AT_DENSITY` |
| Parking rate (zone-specific) | Provision | `provisionType: parking`, `measureValue`, `APPLIES_IN` |
| Parking rate (general to a use class) | LandUse | `parking` (string, e.g. "1 bay per 20m² NLA") |
| Floorspace limit (per-use maximum) | Provision | `measureValue` + `RESTRICTS` → LandUse |
| Landscaping ratio | Provision | `measureValue` + `APPLIES_IN` |
| Car parking ratio | Provision | `measureValue` + `APPLIES_IN` |
| Lot frontage (R-Code standard) | DensityCode | `minLotFrontage` |
| Effective frontage (zone-wide) | Provision | `content` + `APPLIES_IN` |
| Wall height (structure-specific) | Provision | `measureValue` + `REGULATES` → StructureType |
| Maximum volume, diameter, quantity (structure-specific) | Provision | `measureValue` + `REGULATES` → StructureType |
| Maximum employees, maximum area (use-specific) | Provision | `measureValue` + `RESTRICTS` → LandUse |
| Maximum occupancy period | Provision | `measureValue` or `content` + `RESTRICTS` → LandUse |
| Maximum sign area (use-specific) | Provision | `measureValue` + `RESTRICTS` → LandUse |
| Density code applicable to a use | (none) | `APPLIES_AT_DENSITY` relationship — NOT a `densityCode` property |
| Operational restriction (e.g. "no boat left suspended") | Provision | `content` + `REGULATES` or `RESTRICTS` |
| Zone objectives | Zone | `objectives` |
| Scheme/policy definition of a land use | LandUse | `definition` |
| Plain-language description of a structure or precinct | StructureType / Precinct | `description` (NEVER `definition` — that field only exists on LandUse) |

**Rule of thumb:** Every measurable standard that varies by zone, density, precinct, or structure type is a Provision. Every operational restriction with specific conditions is a Provision. Only the broad, type-wide, unconditional properties belong directly on the entity.

---

## Entity Naming Rules

These rules produce consistent, canonical labels that prevent duplicate entities and orphan relationships across planning documents.

### PlanningInstrument Labels

**Format:** The official title as stated in the document.

| Correct | Incorrect |
|---------|-----------|
| `Local Planning Scheme No. 12` | `LPS12` (abbreviation only) |
| `Local Planning Policy No. 1 — Residential Design Codes` | `Residential Policy` (too vague) |
| `Community Purpose Land Policy` | `Community Policy` (too vague) |

If the document has both a reference number and a title, use both: `LPP2: Signage`.

### Zone Labels

**Format:** The zone name as it appears in the scheme, in title case.

| Correct | Incorrect |
|---------|-----------|
| `Residential` | `residential zone` (lowercase, includes "zone") |
| `Strategic Centre` | `strategic centre` (lowercase) |
| `Service Commercial` | `Commercial` (too generic — there are multiple commercial zone types) |
| `Rural Smallholdings` | `Rural Small Holdings` (wrong spacing) |

**Use the scheme's exact name.** Do not abbreviate, reword, or generalize zone names. "Neighbourhood Centre" and "Local Centre" are distinct zones — do not merge them.

### LandUse Labels

**Format:** The use name exactly as defined in the scheme's land use table.

| Correct | Incorrect |
|---------|-----------|
| `Single House` | `Single Dwelling` (wrong term) |
| `Grouped Dwelling` | `Townhouse` (colloquial, not the scheme term) |
| `Restaurant/Cafe` | `Restaurant` (incomplete — the scheme defines them together) |
| `Shop` | `Retail` (too generic) |

**Use the scheme's defined use terms.** Planning schemes define specific use classes with legal precision. "Shop" and "Showroom" are distinct uses with different permissibility — do not combine them.

### Provision Labels

**Format:** `{provisionType}: {short description}` including the key measurable standard.

| Correct | Incorrect |
|---------|-----------|
| `Setback: 6.0m primary street setback for R20` | `Street setback` (too generic) |
| `Height limit: 9.0m maximum building height in Residential` | `Height` (no context) |
| `Exemption: Awning sign exempt from approval` | `Awning sign rule` (unclear what the rule does) |
| `Parking: 1 bay per dwelling for grouped dwellings` | `Parking requirement` (no specifics) |

**Include the measurable value and the scope in the label.** Provisions are numerous — labels must distinguish them without reading properties.

### StructureType Labels

**Format:** The structure name as used in the planning instrument.

| Correct | Incorrect |
|---------|-----------|
| `Single House` | `House` (too generic) |
| `Pylon Sign` | `Freestanding Sign` (the scheme calls it "pylon sign") |
| `Finger Jetty` | `Jetty` (multiple jetty types exist) |
| `Mechanical Boat Lift` | `Boat Lift` (there are also floating/sea pen types) |

### CommunityFacility Labels

**Format:** The specific facility type name, not a vague plural category.

| Correct | Incorrect |
|---------|-----------|
| `Community Centre` | `Community Facilities` (too vague — sounds like a category, not a facility type) |
| `Sports Ground` | `Sport & Recreation Facilities` (category name, not a facility) |
| `Library` | `Libraries` (use singular) |
| `Cultural Facility` | `Arts and Cultural Facilities` (use the vocabulary's recommended term) |

Use the recommended `facilityType` values from the vocabulary as a guide for naming. Each CommunityFacility entity represents a specific type of facility, not a broad service category.

### Precinct Labels

**Format:** The precinct or estate name as used in the document.

| Correct | Incorrect |
|---------|-----------|
| `Port Mandurah Stage 1` | `Port Mandurah` (ambiguous — there are multiple stages) |
| `Mandurah Ocean Marina` | `Marina` (too generic) |
| `Apollo Place Heritage Area` | `Apollo Place` (missing the heritage designation) |

---

## Relationship Referencing Rules

**Every `sourceLabel` and `targetLabel` in a relationship MUST exactly match the `label` of an entity you have created.** This is the single most important rule for preventing orphan relationships.

When creating a relationship:
1. Check the entity label you assigned earlier in this extraction
2. Use that exact label in `sourceLabel` or `targetLabel`
3. Do NOT abbreviate zone names or shorten provision labels

Example — if you created a Zone with label `Neighbourhood Centre`:
- Relationship targetLabel: `Neighbourhood Centre` (correct)
- Relationship targetLabel: `Neighbourhood` (WRONG — creates orphan)
- Relationship targetLabel: `Neighbourhood Centre Zone` (WRONG — "Zone" was not in the label)

### `APPLIES_IN` vs `APPLIES_IN_PRECINCT`

These two relationships sound similar but target different entity types — mixing them is a common failure.

- **`APPLIES_IN`** — targets **Zone** only. Use when a provision applies across a whole zone (e.g., "In the Residential zone, the primary street setback is 6.0m").
- **`APPLIES_IN_PRECINCT`** — targets **Precinct** only. Use when a provision applies within a named geographic area such as a heritage area, canal estate, marina, or activity centre (e.g., "In Port Mandurah Stage 1, the canal setback is 4.0m minimum").

**Never point `APPLIES_IN` at a Precinct.** If the spatial scope is a named precinct, use `APPLIES_IN_PRECINCT`. Both can coexist on the same Provision when a provision is zone-wide but has a precinct-specific variant.

---

## Planning Document Type Expectations

Understanding what each document type contains helps you extract accurately and completely.

### Local Planning Schemes (100–500+ pages)

The primary statutory instrument. Contains:
- **Zone definitions and objectives** — create Zone entities with objectives
- **Reserve classifications** — create Reserve entities
- **Land use permissibility tables** — create LandUse entities and PERMITS relationships for every cell
- **General development standards** — create Provision entities for setbacks, height limits, parking, etc.
- **Special control areas** — create Precinct entities for heritage areas, flood zones, etc.
- **Definitions** — use scheme definitions for LandUse entity `definition` properties

**Expected yield:** 10–15 Zones, 5–10 Reserves, 50–100+ LandUse entities, 100–200+ Provision entities, 5–20 Precincts

### Local Planning Policies (10–50 pages)

Non-statutory guidance expanding on scheme provisions. Contains:
- **Detailed development standards** — more specific than the scheme (e.g., exact setbacks per R-Code)
- **Structure type regulations** — create StructureType entities with controls
- **Exemption conditions** — create Provision entities with `provisionType: exemption`
- **Assessment criteria** — capture as Provision entities with qualitative content

**Expected yield per policy:** 10–30 Provision entities, 5–15 StructureType entities, 5–10 REGULATES relationships

### Community Infrastructure Strategies (20–100 pages)

Population-based planning frameworks. Contains:
- **Hierarchy levels** — create HierarchyLevel entities
- **Facility types and land requirements** — create CommunityFacility entities
- **Population-to-facility ratios** — capture as REQUIRES_FACILITY relationships
- **Location criteria** — capture in provision or facility `description` properties

**Expected yield:** 3–5 HierarchyLevel entities, 10–20 CommunityFacility entities, 30–50 REQUIRES_FACILITY relationships

---

## Zone Permissibility Extraction

This is the most data-dense extraction task. Planning schemes contain permissibility tables with hundreds of cells.

### Permissibility Code Meanings

| Code | Meaning | How to Model |
|------|---------|--------------|
| `P` | Permitted — can proceed without discretionary assessment | `PERMITS` with `permissibility: "P"` |
| `D` | Discretionary — council assesses against scheme objectives | `PERMITS` with `permissibility: "D"` |
| `A` | Not permitted unless council advertises and approves | `PERMITS` with `permissibility: "A"` |
| `X` | Not permitted — cannot be approved under the scheme | `PERMITS` with `permissibility: "X"` |

### Extraction Approach for Permissibility Tables

1. Create ALL `LandUse` entities first (one per row in the table)
2. Create ALL `Zone` entities first (one per column in the table)
3. For each cell, create a `PERMITS` relationship from Zone to LandUse with the correct code
4. If a cell has a footnote or condition, capture it in the `conditions` property

**Do not skip `X` entries.** Knowing that a use is NOT permitted in a zone is as valuable as knowing it IS permitted. Create `PERMITS` relationships with `permissibility: "X"` for prohibited uses.

### Common Mistakes

- Treating "–" (dash) as "not listed" — in most scheme tables, a dash means not permitted (`X`)
- Missing conditional permissibility — some cells have both a code and a note (e.g. "D — max 200m² NLA")
- Combining use classes — "Shop" and "Convenience Store" are separate uses even if they seem similar

---

## Waterway Structure Extraction

Canal estate documents contain detailed waterway structure controls. Extract with precision.

### Key Concepts

| Term | Meaning | Entity Type |
|------|---------|-------------|
| **Jetty envelope** | Designated zone where a jetty may be placed | Property on Precinct or StructureType |
| **Mooring envelope** | Designated zone where a vessel may be moored | Property on Precinct or StructureType |
| **Jetty Arrangement Plan (JAP)** | Shared jetty access agreement between properties | Provision with reference |
| **AHD** | Australian Height Datum — the elevation reference | Used in measureValue (e.g. "1.0m AHD") |
| **Chafer** | Rubber bumper on canal wall to protect vessels | StructureType or property on Precinct |

### Canal Estate Variations

Different canal estates have different rules. Always create separate provisions per estate:

| Estate | Key Difference |
|--------|---------------|
| Port Mandurah Stage 1 | Strict 4m minimum / 6m average canal setback |
| Waterside Canals | Strict canal setbacks, specific jetty envelope rules |
| Southport Canals | Jetties and boat lifters PROHIBITED — narrow canals, chafers provided |
| Mandurah Ocean Marina | Multiple mooring types (A–E) with vessel length limits |

**Critical rule:** Southport Canals prohibits all jetties and boat lifters. This is a significant exception — always model it as a separate provision.

### Mooring Type Classification (Mandurah Ocean Marina)

| Type | Vessel Size | Where |
|------|------------|-------|
| A | 6m power/rowing | Precinct 1, 2 (standard) |
| B | 8m power/rowing | Lot 246 only |
| C | 10m power/rowing | Lot 247 only |
| D | 10m power/sail | Lots 259–268, 320 (remote mooring) |
| E | Group mooring, multiple boats | Lots 270, 315 |

Create one `StructureType` entity per mooring type with the vessel size and location constraints.

**Spatial linking for mooring types:** Every mooring type MUST have an `APPLIES_IN_PRECINCT` relationship to the precinct it applies in, with a `scope` property encoding the lot-level constraint. Do NOT create separate Lot entities — encode lot specificity in the `scope` property.

| Mooring Type | APPLIES_IN_PRECINCT target | `scope` property |
|---|---|---|
| Type A | Mandurah Ocean Marina Precinct 1 | "Generally, lots with waterway frontage" |
| Type B | Mandurah Ocean Marina Precinct 1 | "Lot 246 only" |
| Type D | Mandurah Ocean Marina Precinct 2 | "Lots 259-268 and Lot 320" |

**Self-check:** Before finishing canal estate extraction, verify every StructureType and every Provision has at least one spatial link (`APPLIES_IN_PRECINCT` or `APPLIES_IN`). If a mooring type or structure control floats without a spatial link, it cannot answer "what applies here?" queries.

### Prohibition Modelling for Canal Estates

When a precinct prohibits a structure type entirely, model it with BOTH spatial and structural links:

1. Create a `Provision` with label "Prohibition: {structure} not permitted in {precinct}"
2. Link via `APPLIES_IN_PRECINCT` → the precinct
3. Link via `REGULATES` → EACH prohibited StructureType, with `aspect: "prohibition"` and `conditions: "Within {precinct}"`
4. Also set the prohibition in the Precinct entity's `specialProvisions` property as a human-readable summary

This enables both "what applies in this precinct?" and "what regulates this structure type?" queries.

**Important:** If a prohibition says "No jetties or boat lifting structures", create `REGULATES` to EVERY applicable structure type — all jetty subtypes (Finger Jetty, T-Shaped Jetty, etc.) AND all boat lifting structure types (Mechanical Boat Lifting Structure, Sea Pen, etc.). Do not target only one.

---

## Signage Extraction

Signage policies define two categories — exempt and approval-required. Model both.

### Exempt vs Approval-Required

| Category | Meaning | Model As |
|----------|---------|----------|
| Exempt | May be erected without development approval IF conditions are met | StructureType with `approvalRequired: false` + Provision with `provisionType: "exemption"` |
| Approval-required | Requires development approval | StructureType with `approvalRequired: true` + Provision with `provisionType: "signage-control"` |

### Exempt Sign Conditions

Every exempt sign has conditions — if the conditions are not met, approval IS required. Capture conditions in the Provision's `conditionText` or `exemptionText`. Common conditions:
- Maximum dimensions (height, width, area)
- Maximum number per property or per frontage
- No illumination or only specified illumination
- Not projecting beyond property boundary
- Not obscuring traffic signs or signals

### Inflatable Sign Special Rules

Inflatable signs have unique temporal and insurance controls:
- Maximum 28 days display
- Maximum 3 times per year
- Minimum 28 days between displays
- $10M public liability insurance required
- Structural engineer certification required

These are multiple separate provisions — create each as a distinct entity.

---

## Residential Density Code Extraction

R-Code documents are highly structured with tables of standards per density.

### Extraction Pattern

For each R-Code (R2, R5, R10, R12.5, R17.5, R20, R25, R30, etc.):
1. Create a `DensityCode` entity with lot size, coverage, and setback properties
2. For each development standard that varies by density, create a `Provision` entity
3. Link each Provision to the DensityCode via `APPLIES_AT_DENSITY`

### Common R-Code Provisions to Extract

| Provision Type | What to Capture |
|----------------|-----------------|
| Primary street setback | Distance in metres, any variation by lot width |
| Secondary street setback | Distance in metres |
| Side setback | Distance in metres, wall-on-boundary rules |
| Rear setback | Distance in metres |
| Open space | Percentage of lot |
| Site coverage | Percentage of lot |
| Building height | Maximum in metres or storeys |
| Wall height | Maximum in metres |
| Setback to canal wall | Distance + average setback if applicable |
| Outbuilding area | Base area + per-lot-area formula |

### Wall-on-Boundary Rules

Some density codes permit walls on or close to boundaries. These are conditional provisions:
- Typically allowed from R12.5 upwards
- Subject to wall height and length limits
- Often require neighbour consultation
- Create as separate Provision with `conditionText` capturing the conditions

---

## Community Infrastructure Hierarchy Extraction

### Population-Based Model

The community purpose land policy establishes a 5-tier hierarchy. For each tier:
1. Create a `HierarchyLevel` entity with population range
2. Identify the facility types required at that tier
3. Create `CommunityFacility` entities (deduplicate across tiers)
4. Create `REQUIRES_FACILITY` relationships with land size and priority

### Developing vs Developed Suburb Strategies

The policy distinguishes acquisition strategies:
- **Developing suburbs** — acquire land during subdivision via developer contributions
- **Developed suburbs** — retain existing facilities, consider land swaps, co-locate

Capture this distinction in Provision entities with `conditionText` describing the strategy context.

---

## Anti-Hallucination Rules

Council planning extraction errors can mislead development decisions. These rules prevent the most dangerous mistakes.

### Rule 1: Extract what the document states, not what you think planning schemes should contain

Do NOT fill in "standard" provisions that aren't in the document:

| Property | Hallucination Example | Why It's Dangerous |
|----------|-----------------------|-------------------|
| `primaryStreetSetback` | Inserting "6.0m" because that's typical for R20 | This council may have a different standard |
| `permissibility` | Marking a use as "P" because it seems like it should be permitted | Each council's scheme is different — check the actual table |
| `maxBuildingHeight` | Inserting "9.0m" for residential | Height limits vary by zone and policy |

**Test:** For every property value, ask: "Can I point to the exact text in the document that states this?" If no, omit the property.

### Rule 2: Don't generalize location-specific rules

Each canal estate, heritage area, and special precinct has its own rules. Do NOT apply one precinct's rules to another:

| Document Says | Correct | Wrong |
|---------------|---------|-------|
| "In Port Mandurah Stage 1, setback to canal wall shall be minimum 4.0m" | Provision applies in Precinct "Port Mandurah Stage 1" only | Applying 4.0m setback to all canal estates |
| "Jetties prohibited in Southport Canals" | Prohibition provision for Precinct "Southport Canals" only | Prohibiting jetties in all canal estates |

### Rule 3: Don't infer permissibility from zone names

A "Residential" zone may permit shops (as discretionary). A "Tourism" zone may prohibit tourist development in certain circumstances. Read the actual permissibility table — do not guess from the zone name.

### Rule 4: Don't merge distinct provisions

If a section states both a setback and a height limit, ALWAYS create separate Provision entities even if they appear in the same sentence. The graph structure should reflect the distinct rules, not the document layout.

### Rule 5: Don't create entities for bibliographic references

Documents listed in "Supporting Documents", "Related Documents", or "References" sections are citations, not planning instruments to be indexed. Do NOT create PlanningInstrument entities for them. Only the document being indexed (and its direct parent instrument for `SUBORDINATE_TO`) should produce PlanningInstrument entities.

| Document Says | Correct | Wrong |
|---------------|---------|-------|
| "Supporting Documents: Active Ageing Plan, Youth Development Strategy, Property Strategy" | No entities created — these are bibliographic references | Creating 3 PlanningInstrument entities |
| "This policy is based on a key recommendation of the Social Infrastructure Plan 2013-43" | Optional: one stub PlanningInstrument with `REFERENCES_INSTRUMENT`, because it substantively informs the policy | Creating a full PlanningInstrument with properties inferred from the reference |

**SUBORDINATE_TO vs REFERENCES_INSTRUMENT:** Use `SUBORDINATE_TO` ONLY when a policy is formally adopted under a statutory planning instrument (e.g., "This policy is adopted under Local Planning Scheme No. 12"). Use `REFERENCES_INSTRUMENT` when the policy is informed by or based on another document but is not formally subordinate. The test: "adopted under" → `SUBORDINATE_TO`; "based on" / "implements" / "informed by" → `REFERENCES_INSTRUMENT`.

### Rule 6: Don't infer facility-to-tier mappings — ZERO TOLERANCE

If a hierarchy table shows population ranges and land sizes but does not explicitly state which facility types serve which tier, do NOT create `REQUIRES_FACILITY` relationships AND do NOT create `CommunityFacility` entities. The table defines the tiers, not the facility mix.

**Column test:** Look at the table columns. If there is no column that maps facility types to tiers, the answer is zero `REQUIRES_FACILITY` relationships and zero `CommunityFacility` entities. Facility types mentioned in the document's *objectives* or *purpose* section are aspirational categories — they do NOT justify creating entities or relationships tied to specific tiers.

| Document Says | Correct | Wrong |
|---------------|---------|-------|
| Table with columns: Category, Population, Land Size | Create `HierarchyLevel` entities with population and land size properties ONLY. No `CommunityFacility` entities. No `REQUIRES_FACILITY` relationships. | Creating `CommunityFacility` entities from objective text, then linking them to tiers via `REQUIRES_FACILITY` |
| Table with columns: Category, Population, Land Size, Facility Types | Create `HierarchyLevel` entities, `CommunityFacility` entities, and `REQUIRES_FACILITY` relationships | N/A — this table explicitly maps facilities to tiers |

**Self-check:** Before submitting, count your `REQUIRES_FACILITY` relationships. If the hierarchy table has no facility column and your count is > 0, you have hallucinated. Delete them all.

### Rule 7: Distinguish between scheme standards and policy variations

Where a local planning policy modifies a scheme standard, create BOTH provisions and link them via `OVERRIDES`:
- The scheme provision (from the scheme document)
- The policy provision (from the policy document, with `OVERRIDES` → scheme provision)

This preserves the hierarchy and makes it clear which rule applies.

### Rule 8: Numeric fields must be numbers, not strings

Properties typed as `number` in the vocabulary must be submitted as JSON numbers, not quoted strings.

| Entity | Numeric property | Correct | Wrong |
|---|---|---|---|
| Zone | `maxPlotRatio` | `2.0` | `"2.0"` |
| Zone | `minLotSize` | `2000` | `"2000"` |
| Zone | `maxRetailFloorspace` | `5000` | `"5000"` |
| DensityCode | `minLotSize`, `avgLotSize`, `maxSiteCoverage`, `minOpenSpace` | `450` | `"450"` |
| HierarchyLevel | `populationMin`, `populationMax` | `7500` | `"7500"` |

String-typed properties (e.g., `maxBuildingHeight`, `primaryStreetSetback`, `measureValue`) may include unit suffixes and should remain strings — e.g., `"9.0m"`, `"6.0m"`, `"60m²"`. Only coerce to a JSON number when the vocabulary type is `number`.

---

## Extraction Error Patterns (Observed)

These errors were found during spot-checking of actual extraction outputs. They represent **real mistakes** — study each one and avoid repeating them.

### Error 1: Prohibitions mislabeled as exemptions

When a document says a structure type "is not permitted" or "shall not be erected", this is a **prohibition**, not an exemption. Do NOT use `provisionType: "exemption"` or the `EXEMPTS` relationship for prohibitions.

**How to model a prohibition:**
- Create a `Provision` with `provisionType: "waterway-control"` or `"signage-control"` (matching the domain)
- Set the `content` to clearly state the prohibition
- Use `REGULATES` from the Provision to the StructureType (not `EXEMPTS`)
- If the prohibition targets a land use rather than a structure, use `RESTRICTS` with `restrictionType: "prohibited"`

| Document says | Wrong | Right |
|---------------|-------|-------|
| "Boat lifters of any type are not permitted" | Provision with `provisionType: "exemption"` + `EXEMPTS` relationship | Provision with `provisionType: "waterway-control"`, label "Prohibition: Boat lifters not permitted in Precinct X" + `REGULATES` relationship |
| "Inflatable signs are prohibited in zone Y" | `EXEMPTS` → Inflatable Sign | Provision with `provisionType: "signage-control"` + `REGULATES` → Inflatable Sign |

### Error 2: Self-referencing relationships

A `CONTAINS_PROVISION` relationship must go from a **PlanningInstrument** to a **Provision**. Never create a relationship where the source and target are the same entity. If both labels are the same, you have a bug.

| Wrong | Right |
|-------|-------|
| `CONTAINS_PROVISION` from "LPP1" to "LPP1" | `CONTAINS_PROVISION` from "LPP1" to "Setback: 6.0m primary street for R20" |

### Error 3: Over-attributing general provisions to specific entities

When a document states a rule that applies generally (e.g., "rebadging or replacing existing approved signage is exempt"), do NOT create individual relationships to every structure type. Create ONE provision with the general rule in `content` and link it to the PlanningInstrument via `CONTAINS_PROVISION` only. Do NOT fan out `EXEMPTS` or `REGULATES` relationships to individual StructureType entities.

**The test:** Does the exemption or rule depend on the structure type? If it applies to ANY existing approved instance regardless of type, it is a general provision — no per-type relationships.

| Document says | Wrong | Right |
|---------------|-------|-------|
| "Replacing existing approved signage is exempt from approval" | 5+ separate `EXEMPTS` → Awning Sign, Projecting Sign, etc. | 1 Provision with `provisionType: "exemption"`, `content` stating the general rule. Link to PlanningInstrument via `CONTAINS_PROVISION` only. No `EXEMPTS` fan-out. |
| "Election signs are exempt during election periods" | 8 separate `EXEMPTS` → every sign type | 1 Provision with scope in `content`. The exemption is for a category of sign, not per-type. |

**Only use `EXEMPTS` → StructureType** when the exemption is specifically conditional on the structure type (e.g., "Awning signs not exceeding 600mm are exempt" — this is type-specific, so `EXEMPTS` → Awning Sign is correct).

### Error 4: Contradictory properties on entities

When setting properties on a StructureType, ensure internal consistency. If `approvalRequired` is `false`, then `structureCategory` should NOT contain "approval-required".

| Wrong | Right |
|-------|-------|
| `approvalRequired: false` + `structureCategory: "sign-approval-required"` | `approvalRequired: false` + `structureCategory: "sign-exempt"` |

### Error 5: APPLIES_AT_DENSITY used for benchmark references

`APPLIES_AT_DENSITY` means a provision governs development at that density. If a policy says "lots at R12.5–R17.5 may use the R20 standard as a reference", the R20 is a **benchmark**, not a governed density. Model as:
- Provision with `content` explaining the benchmark reference
- `APPLIES_AT_DENSITY` to R12.5 and R17.5 (the densities actually governed)
- Do NOT create `APPLIES_AT_DENSITY` to R20 unless the provision also directly governs R20 lots

### Error 6: Precinct/location attribution errors

When a document lists provisions estate-by-estate or precinct-by-precinct, match each provision to its **exact** precinct. Do not shift labels between precincts. Pay close attention to section headings and numbering — if a prohibition appears under the heading "Precinct 1", attribute it to Precinct 1, not Precinct 6(A).

**Verification step:** After extracting precinct-specific provisions, re-read the section headings in the source to confirm each provision is attributed to the correct precinct.

### Error 7: Missing SUPERSEDES relationships for predecessor instruments

When a policy explicitly states it replaces or supersedes earlier policies, create a separate `SUPERSEDES` relationship from the new PlanningInstrument to a stub of EACH predecessor. Do NOT merge multiple predecessors into a single entity or fold one into another's aliases.

| Document says | What to create |
|---------------|----------------|
| "This policy replaces Local Planning Policy No. 9 — Advertising Devices" and "This policy replaces LPP7 dated March 2010" | TWO stub PlanningInstruments: one for LPP9 with `status: "superseded"`, one for LPP7 with `status: "superseded"` and `effectiveDate: "2010-03"`. TWO `SUPERSEDES` relationships, each with `reason` from the document text. |

**Record the reason:** Set `properties.reason` on the `SUPERSEDES` relationship to the document text that states the supersession (e.g., "This policy replaces LPP7 dated March 2010").

### Error 8: Missing operational restrictions and numeric thresholds

Every specific numeric threshold, dimensional limit, or operational restriction stated in the source must be captured — either as a property on an entity or as a separate Provision. Common omissions:
- Setback distances (e.g., "2.0m minimum setback to property boundaries")
- Operational prohibitions (e.g., "No boat is to be left suspended from the Davit at any time")
- Enforcement escalation details (e.g., "7-day removal notice" vs "immediate infringement for repeat offences")
- Zone restrictions (e.g., "permitted in all zones except Residential")

**Test:** After extracting a section, re-read it and ask: "Is there a specific number, distance, or restriction mentioned that I did not capture?" If yes, create an additional Provision.

### Error 9: Wrong entity type as relationship endpoint

The following relationship endpoint types are **HARD CONSTRAINTS**. There are no exceptions. A relationship with the wrong endpoint type is a broken relationship — it will not answer the queries it's supposed to answer.

| Relationship | Source | Target |
|---|---|---|
| `CONTAINS_PROVISION` | PlanningInstrument | Provision ONLY |
| `PERMITS` | Zone | LandUse ONLY |
| `REGULATES` | Provision | StructureType ONLY |
| `RESTRICTS` | Provision | LandUse ONLY |
| `EXEMPTS` | Provision | StructureType ONLY |
| `APPLIES_IN` | Provision | Zone ONLY |
| `APPLIES_IN_PRECINCT` | Provision | Precinct ONLY |
| `APPLIES_AT_DENSITY` | Provision | DensityCode ONLY |
| `CLASSIFIED_UNDER` | DensityCode | Zone ONLY |
| `LOCATED_IN` | Precinct | Zone ONLY |
| `WITHIN_RESERVE` | Precinct | Reserve ONLY |
| `REFERENCES_INSTRUMENT` / `SUBORDINATE_TO` / `SUPERSEDES` | PlanningInstrument | PlanningInstrument ONLY |
| `OVERRIDES` / `REFERENCES_PROVISION` | Provision | Provision ONLY |
| `REQUIRES_FACILITY` | HierarchyLevel | CommunityFacility ONLY |

**Label-collision resolution.** Labels like "Single House", "Car Park", and "Outbuilding" legitimately exist as both a LandUse entity and a StructureType entity — they are **separate entities** with the same label. When creating relationships, pick the correct type:

- **PERMITS (from Zone):** use the **LandUse** entity. "Zone permits Single House" means the land use is permitted.
- **REGULATES / EXEMPTS (from Provision):** use the **StructureType** entity. "Provision regulates Single House" means the building form is regulated.
- **RESTRICTS (from Provision):** use the **LandUse** entity. "Provision restricts Single House" means the activity is restricted.

Never reuse one entity for both roles. If your extraction only produced a LandUse "Car Park" but you need to wire a REGULATES relationship, create the StructureType "Car Park" — do not point REGULATES at the LandUse.

**Unknown relationship properties are also a violation.** Only set properties listed in the vocabulary for that relationship type. For example, `REGULATES` supports `aspect`, `measureValue`, `conditions` — do not add `measureUnit` or other ad-hoc fields.

### Error 10: Provision entities without `content`

`content` is a **required** field on every Provision. A Provision label is not a substitute. Labels like "Setback: Secondary street wall setback 1.0m for R12.5 and higher" describe the rule but do not satisfy the `content` requirement — the label is a navigation aid, the `content` is the rule text.

Before finalising any batch of Provisions, verify every entity has `content` set to one of:
- The **verbatim** scheme or policy text, or
- A **faithful plain-language summary** of the rule that preserves all numeric thresholds and conditions

A Provision missing `content` will fail validation. Do not submit incomplete Provision entities.

### Error 11: Stub PlanningInstruments missing required fields

When creating a stub PlanningInstrument (for `SUBORDINATE_TO`, `SUPERSEDES`, or `REFERENCES_INSTRUMENT`), the vocabulary's required fields still apply. At minimum, set:

- `title` — the official name of the instrument (required)
- `instrumentType` — use best judgement from the context (e.g., `local-planning-scheme` for a parent scheme reference)
- `status` — use `operative` unless the document indicates `superseded` or `draft`

A stub with a blank or missing `title` will fail validation even though the entity exists only to support a relationship.

### Error 12: Non-use concepts incorrectly typed as LandUse

Only create `LandUse` entities for activities **explicitly defined as use classes in the planning scheme's land use table**. Do NOT create LandUse entities for:

- **Lot configurations** — e.g. "Battle-Axe Lot", "Corner Lot", "Green Title Lot". These are lot types, not land uses.
- **Environmental categories** — e.g. "Bushland", "Wetland", "Foreshore". These are land classifications or reserve types, not use activities.
- **Vehicle categories** — e.g. "Commercial Vehicle" unless the scheme lists it as a defined use.
- **Tenure categories** — e.g. "Crown Reserve", "Freehold Land". These are definitions in the scheme glossary, not uses.

**Test:** Does this label appear as a row in the scheme's zoning / permissibility table? If no, it is not a LandUse. Model it as:
- A Provision (if it's a rule or constraint), or
- A Precinct (if it's a named area with special provisions), or
- A Reserve (if it's a reserved land classification), or
- Omit it (if it's a glossary definition with no associated rule).

### Error 13: Orphan relationships — missing target StructureType / LandUse entity

Observed in real runs: the extractor creates a `Provision` with a setback/height rule for a structure type (e.g. "boundary wall setback 1.0m", "front fence max 900mm", "pergola canal setback 3m"), then writes a `REGULATES` relationship targeting that structure type — but **never creates the StructureType entity itself**. The result is an orphan relationship that fails validation.

| Observed orphan | Root cause |
|---|---|
| `REGULATES → Boundary Wall` | No `StructureType: Boundary Wall` created (map to `structureCategory: retaining-wall`) |
| `REGULATES → Fence` | No `StructureType: Fence` created (map to `structureCategory: fence`) |
| `REGULATES → Pergola` | No `StructureType: Pergola` created (map to `structureCategory: patio-pergola`) |

**Rule:** Whenever you write a rule that mentions a physical structure (boundary wall, fence, pergola, outbuilding, carport, patio, deck, sign, jetty, pool, etc.), you have TWO entities to create:
1. The `Provision` carrying the rule.
2. The `StructureType` the rule regulates.

Then wire them with `REGULATES`.

**Self-check before submitting:** for every `REGULATES`, `RESTRICTS`, `EXEMPTS`, `PERMITS`, `APPLIES_IN`, `APPLIES_IN_PRECINCT`, `APPLIES_AT_DENSITY`, `CLASSIFIED_UNDER`, `LOCATED_IN` — is the target entity in your list? If not, create it (minimal stub is fine) or drop the relationship.

---

## Common Extraction Pitfalls

### 1. Combining zone types

| Source Text | Wrong | Right |
|-------------|-------|-------|
| "Strategic Centre zone" and "District Centre zone" | One Zone entity "Centre" | Two Zone entities: "Strategic Centre" and "District Centre" |
| "Rural Residential" and "Rural Smallholdings" | One Zone entity "Rural" | Two Zone entities: "Rural Residential" and "Rural Smallholdings" |

**Each zone is a separate legal classification.** Never combine zones that appear similar.

### 2. Missing permissibility table entries

Permissibility tables are large and dense. Common errors:
- Skipping "X" (not permitted) entries — these are valuable
- Missing rows for less common uses (e.g. "Caretaker's Dwelling", "Home Business")
- Conflating footnote conditions with the base permissibility code

**After extraction, count:** The number of PERMITS relationships should roughly equal (number of zones × number of land uses). If significantly less, you have missed entries.

### 3. Confusing scheme provisions with policy provisions

Schemes and policies may both address the same topic (e.g. setbacks). They are separate provisions from separate instruments:

| Source | Entity |
|--------|--------|
| LPS12 clause 5.3 says "setbacks per R-Codes" | Provision linked to PlanningInstrument "Local Planning Scheme No. 12" |
| LPP1 says "primary street setback for R20 is 6.0m" | Provision linked to PlanningInstrument "LPP1: Residential Design Codes" with OVERRIDES → scheme provision |

### 4. Inconsistent structure type labeling

If you create a "Pylon Sign" entity in one part of the extraction, do NOT later refer to it as "Freestanding Sign" or "Pole Sign" in a relationship. Use the EXACT same label throughout.

### 5. Missing precinct-specific provisions

Canal estate documents often contain estate-by-estate rules. Do not extract a single "canal setback" provision — create separate provisions for each estate where the rules differ:
- Port Mandurah Stage 1: 4m min / 6m average
- Waterside Canals: specific setback rules
- Southport Canals: jetties prohibited entirely

### 6. Incomplete hierarchy level extraction

Community infrastructure strategies define requirements at each population tier. Extract ALL tiers and ALL facility types per tier. Missing a tier breaks the population-based query model.

---

## Planning Terminology Reference

Key terms that help with accurate extraction:

| Term | Meaning | Extraction Impact |
|------|---------|-------------------|
| **Gazetted** | Officially published in the government gazette | Set `status: "gazetted"` or `gazettalDate` |
| **Operative** | Currently in legal effect | Set `status: "operative"` |
| **R-Codes** | Residential Design Codes (state-wide) — density classifications | Create `DensityCode` entities |
| **NLA** | Net Lettable Area — commercial floor area measure | Used in parking and floorspace standards |
| **GFA** | Gross Floor Area — total building floor area | Used in plot ratio calculations |
| **Plot ratio** | Ratio of GFA to site area | `provisionType: "plot-ratio"` |
| **Site coverage** | Percentage of lot covered by buildings | `provisionType: "site-coverage"` |
| **AHD** | Australian Height Datum — elevation reference | Used in waterway structure heights |
| **Structure plan** | Area development framework guiding subdivision | PlanningInstrument entity |
| **Activity centre** | Concentrated area of commercial, civic, and residential use | Zone or Precinct entity |
| **Setback** | Required distance between building and boundary/feature | `provisionType: "setback"` |
| **Curtilage** | Area around a heritage place forming its setting | Property on Precinct or Provision |
| **Primary distributor road** | Major road carrying regional traffic | Used in setback and access provisions |
| **District distributor road** | Road connecting suburbs to primary distributors | Used in setback and access provisions |
| **P permissibility** | Permitted as of right — no discretionary assessment | `permissibility: "P"` |
| **D permissibility** | Discretionary — assessed against scheme objectives | `permissibility: "D"` |
| **A permissibility** | Not permitted unless advertised and approved | `permissibility: "A"` |
| **Grouped dwelling** | Two or more dwellings on one lot sharing common property | LandUse entity |
| **Multiple dwelling** | Three or more dwellings in a building (apartments) | LandUse entity |
| **Ancillary dwelling** | Small self-contained dwelling on same lot as main dwelling | LandUse entity |
| **Home business** | Business operated from a dwelling — various categories | LandUse entity |
| **Jetty Arrangement Plan (JAP)** | Agreement for shared jetty access between properties | Referenced in waterway provisions |
| **Mooring envelope** | Designated water area for vessel placement | Property on Precinct or StructureType |
| **Jetty envelope** | Designated area for jetty construction | Property on Precinct or StructureType |
| **Chafer** | Rubber bumper on canal wall protecting vessels | Referenced in canal estate provisions |
