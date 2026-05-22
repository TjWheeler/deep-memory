# Mining Equipment Domain — Indexing Strategy

This document provides document-type-specific guidance for indexing mining equipment documentation. It describes what to extract from each source document type, how deep to go, what to prioritize, and how to phase the work for maximum value at each stage.

This is intended for users and AI agents planning an indexing campaign against a collection of mining equipment documentation.

---

## CRITICAL: Extraction Accuracy Rules

These rules OVERRIDE all other guidance. Follow them exactly.

### Rule 1: Only Extract What the Source Document Explicitly States

**NEVER** fill in property values from your general knowledge. If the source document does not state a value, do not include that property.

- Do NOT invent weights for components (e.g., "1,250 kg" for an engine) unless the source document states the weight
- Do NOT invent materials (e.g., "hardened steel", "aluminum alloy") unless the source document states the material
- Do NOT add `serviceable: true` unless the source document explicitly discusses serviceability
- Do NOT add `pressure` values to entities that are not hydraulic systems unless the source states a pressure
- Do NOT infer fluid specifications (e.g., "ISO VG 46", "SAE 15W-40", "Cat ECF-3") unless the source document names them. If the source only lists a capacity (e.g., "Engine oil: 262 L"), create the REQUIRES_FLUID relationship with `capacity` only — omit `specification` until it is confirmed from a fluids publication

**Test:** For every property you extract, you should be able to point to the exact line in the source document that states that value. If you cannot, omit the property.

### Rule 2: Create Equipment Stubs for Relationship Targets

When a COMPATIBLE_WITH, VARIANT_OF, or SUPERSEDES relationship references an Equipment model that does not have its own detailed data in the source, you MUST create a **stub Equipment entity** in the `entities` array. Without the entity, the relationship is invalid.

For each truck or equipment model referenced in a compatibility chart or matching table, create:

```json
{
  "entityType": "Equipment",
  "label": "730E",
  "summary": "Haul truck referenced in truck-shovel matching data",
  "properties": {
    "equipmentType": "haul-truck"
  },
  "aliases": [],
  "sourceRefs": [
    { "description": "Truck-shovel matching chart", "lineStart": 235, "lineEnd": 235 }
  ]
}
```

Keep the stub minimal — only include properties explicitly stated in the source. The stub establishes the graph node so that COMPATIBLE_WITH relationships can connect to it. The entity will be enriched later when the truck's own documentation is indexed.

**This rule is mandatory.** Every entity label referenced in a relationship's `sourceLabel` or `targetLabel` must have a corresponding entry in the `entities` array.

### Rule 3: Flattened Chart Interpretation

Spec sheets frequently contain truck-shovel matching data as a visual chart that flattens badly to text during PDF-to-markdown conversion. The flattened output typically looks like this:

```
Short tons
Number of passes
300
275
250
...
4    5    6
Bucket fill 90%
730E
830E
```

In this layout:
- "Short tons" and "Number of passes" are **axis labels**, not data values
- The large numbers (300, 275, 250, ...) are **Y-axis tick marks** representing truck payload in short tons — they are NOT pass counts
- The small numbers (4, 5, 6) on a single line are the **X-axis values** representing the actual number of passes
- Truck model names (730E, 830E, HD1500) are **chart line labels**

**NEVER** use the Y-axis tonnage values as pass counts. Valid pass counts for truck-shovel matching are always 3-7. If you cannot determine the exact pass count per truck from the flattened chart, **omit passCount entirely** from the COMPATIBLE_WITH properties. Record the `bucketFillFactor` percentages and the truck compatibility, but leave passCount blank rather than recording an incorrect value.

---

## Document Types and What to Extract

### 1. Equipment Spec Sheets (2–6 pages per model)

**Examples:** Komatsu PC7000-11 spec sheet, Komatsu PC4000-11 spec sheet

**Characteristics:** Dense, structured, single-model focus. Tables of specifications, dimensions, capacities, and sometimes truck-shovel match data. These are the fastest documents to index and produce the highest entity-to-page ratio.

**What to extract:**

| Extract | Entity Type | Priority |
|---------|-------------|----------|
| Model identification and classification | Equipment | Critical |
| Operating weight, engine power, bucket capacity | Properties on Equipment | Critical |
| Engine model, cylinders, aspiration, power rating | Component (engine) | Critical |
| Hydraulic system flow, pressure, pump count | Component (hydraulic-system) + sub-components | Critical |
| Undercarriage details (track count, rollers, shoe width) | Component (undercarriage) + sub-components | High |
| Swing system specs | Component (swing-system) | High |
| Fluid capacities (hydraulic, fuel, coolant, engine oil, grease, DEF) | REQUIRES_FLUID relationships with capacity | Critical |
| Cab and operator features | Component (cab) | Medium |
| Electrical system specs | Component (electrical-system) | Medium |
| Monitoring/telematics system | Component (monitoring-system) | Medium |
| Lubrication system details | Component (lubrication-system) | High |
| Attachment configurations (shovel, backhoe, bucket specs) | Component (attachment, bucket) | High |
| GET system (tooth type, count) | Part (get-tooth) + USES_PART | High |
| Truck-shovel matching data | COMPATIBLE_WITH relationships | Critical |
| Dimensions and clearances | Properties on Equipment | Medium |
| Environmental specs (vibration, emissions, refrigerant) | Properties on Equipment/Component | Low |
| Electric drive option availability | VARIANT_OF relationship or property | Medium |

**Granularity guidance:**
- Create **every component** mentioned in the spec sheet, even if details are sparse. A component entity with just a `componentType` and a brief `specifications` property is still valuable — it establishes the node for future enrichment from O&M manuals.
- For fluid capacities, always create the `REQUIRES_FLUID` relationship with `capacity` even if you don't know the exact fluid specification. Use the most likely standard grade (e.g. SAE 15W-40 for diesel engines) and update later if the O&M manual specifies differently.
- For truck-shovel matching, create Equipment entities for the trucks even if you only know their name and payload class. The truck entities will be enriched when you index the truck manufacturer's documentation.

**Expected yield per spec sheet:** 1 Equipment entity, 8–15 Component entities, 3–8 sub-Component entities, 1–3 Part entities, 4–8 Fluid relationships, 0–6 COMPATIBLE_WITH relationships.

---

### 2. Operation and Maintenance (O&M) Manuals (100–500+ pages per model)

**Examples:** Cat 325F L O&M Manual, Cat Mini Excavators 307.5–310 O&M Manual, Cat SEBU8407-06

**Characteristics:** Comprehensive, deeply structured by section. Safety instructions, operating procedures, maintenance schedules (by hour interval), lubrication charts, fluid specifications, troubleshooting guides, and parts references. These are the richest source for maintenance and failure data but the most time-consuming to index.

**What to extract:**

| Section | Extract | Entity Type | Priority |
|---------|---------|-------------|----------|
| **Maintenance Schedule** | Every service interval (10h, 50h, 250h, 500h, 1000h, 2000h) with tasks | MaintenanceProcedure | Critical |
| **Lubrication Chart** | Fluid types, capacities, and change intervals per system | REQUIRES_FLUID with capacity + changeInterval | Critical |
| **Fluid Specifications** | Exact fluid grades, OEM part numbers, industry specs | Fluid entities + properties | Critical |
| **Troubleshooting** | Symptom → cause → remedy tables | FailureMode entities + relationships | High |
| **Component Identification** | Labeled diagrams showing system layout | Component entities (enrichment) | High |
| **Filter Locations/Types** | Filter part numbers, locations, change intervals | Part entities + USES_PART | High |
| **Safety Warnings** | Machine-specific safety procedures | Properties on MaintenanceProcedure | Medium |
| **Operating Procedures** | Start-up, shutdown, operating techniques | Could extend vocabulary if needed | Low |
| **Storage Procedures** | Long-term storage preparation | MaintenanceProcedure (procedureType: storage) | Low |

**Granularity guidance:**
- **Maintenance schedules are the highest-value extraction.** A single O&M manual may define 30–50 distinct maintenance procedures across 6–8 service intervals. Index every one. These directly answer "what's due at X hours?" queries.
- **Lubrication charts provide the definitive fluid data.** If a spec sheet said "engine oil: 472 L" but didn't specify the grade, the O&M manual's lubrication chart will give you the exact specification (e.g. "Cat DEO-ULS 15W-40 or equivalent meeting API CK-4"). Update the existing REQUIRES_FLUID relationship with the precise specification.
- **Troubleshooting tables are structured enough to index directly.** Each row is typically "Problem | Probable Cause | Remedy" — this maps to FailureMode entities with `symptoms`, `rootCause`, and linked corrective MaintenanceProcedure entities.
- **Filter specifications create high-value Part entities.** Every filter has a part number, a location, and a change interval — this is exactly the data inventory planners need.
- **Don't index operating procedures as entities** unless they contain maintenance-relevant information. "How to operate the swing" is not useful in the knowledge graph. "Pre-operation daily inspection checklist" is.

**Expected yield per O&M manual:** 30–50 MaintenanceProcedure entities, 20–40 Part entities (mostly filters and wear items), 10–20 FailureMode entities, 50–100 additional relationships, significant enrichment of existing Component and Fluid entities.

---

### 3. Performance Handbooks (500–1000+ pages, multi-model)

**Examples:** Cat Performance Handbook Edition 50, Komatsu Specifications & Application Handbook Edition 32

**Characteristics:** Fleet-wide reference covering dozens of models per manufacturer. Organized by equipment category (excavators, trucks, dozers, loaders, etc.) with specification summaries, performance charts, application guides, and equipment matching data. These are broad but less deep than O&M manuals.

**What to extract:**

| Section | Extract | Entity Type | Priority |
|---------|---------|-------------|----------|
| **Model Specifications** | Equipment specs for models not covered by individual spec sheets | Equipment entities | High |
| **Equipment Matching** | Truck-shovel matching tables, loader-truck matching | COMPATIBLE_WITH relationships | Critical |
| **Application Data** | Material types, productivity rates, operating conditions | OperationalContext entities + SUITED_FOR | High |
| **Cost Estimation Data** | Operating cost factors, fuel consumption rates | Properties on Equipment | Medium |
| **Model Lineage** | Current vs previous models, what replaced what | SUPERSEDES relationships | Medium |
| **General Fluid Specs** | Fleet-wide fluid recommendations | Fluid entities (enrichment) | Medium |

**Granularity guidance:**
- **Don't index every model in the handbook.** A Cat performance handbook may cover 100+ models. Focus on models relevant to the mining fleet being modeled. Create Equipment entities for models that appear in matching tables or that the client operates.
- **Equipment matching tables are the primary value.** These handbooks often have comprehensive truck-shovel and loader-truck matching tables with pass counts, cycle times, and production rates. Index these as `COMPATIBLE_WITH` relationships with full properties.
- **Application data creates the OperationalContext layer.** Performance handbooks describe which equipment works best in which conditions — this maps to `SUITED_FOR` relationships with productivity data.
- **Model lineage is valuable for fleet planning.** If a handbook shows that the PC7000-11 replaced the PC7000-6, create the `SUPERSEDES` relationship with `keyChanges`.

**Expected yield per handbook:** 20–50 additional Equipment entities (many as stubs for matching), 50–100 COMPATIBLE_WITH relationships, 10–20 OperationalContext entities, 20–30 SUITED_FOR relationships.

---

### 4. Product Brochures (4–20 pages, multi-model)

**Examples:** Komatsu Hydraulic Mining Excavators Brochure

**Characteristics:** Marketing-oriented with high-level specifications across multiple models in a product family. Less detailed than spec sheets but useful for identifying the full model range and key differentiators.

**What to extract:**

| Extract | Entity Type | Priority |
|---------|-------------|----------|
| Model range identification | Equipment entities (stubs) | Medium |
| Key specs per model (weight, power, bucket) | Properties on Equipment | Medium |
| Product family relationships | Could inform VARIANT_OF or SUPERSEDES | Low |
| Technology highlights | Component entities or properties | Low |

**Granularity guidance:**
- Brochures are best used to **create stub Equipment entities** for models not yet indexed from spec sheets. These stubs establish the entity with basic specs and can be enriched later.
- Don't spend time on marketing language or feature descriptions that don't contain structured data.

**Expected yield per brochure:** 5–15 Equipment entity stubs, minor property enrichment.

---

### 5. Fluid and Lubricant Publications (10–50 pages)

**Examples:** Cat Fluids & Lubricants Special Publication

**Characteristics:** Comprehensive fluid specifications across a manufacturer's entire equipment range. Viscosity charts by temperature, approved products, mixing compatibility, and storage requirements.

**What to extract:**

| Extract | Entity Type | Priority |
|---------|-------------|----------|
| Fluid specifications and standards | Fluid entities | Critical |
| Temperature/viscosity recommendations | Properties on Fluid | High |
| Approved product lists by application | Properties or notes on Fluid | Medium |
| Mixing compatibility guidance | ALTERNATIVE_FLUID relationships | High |
| Fluid change intervals by application | Properties on REQUIRES_FLUID relationships | High |
| Coolant specifications and mixing ratios | Fluid entities | High |
| Grease specifications by application point | Fluid entities + notes | Medium |

**Granularity guidance:**
- This document type is the **authoritative source for Fluid entities.** Index it early and use it to enrich REQUIRES_FLUID relationships created from spec sheets.
- Create `ALTERNATIVE_FLUID` relationships where the publication documents acceptable substitutes (e.g. "Cat HYDO Advanced 10 or equivalent meeting ISO VG 46").
- Temperature range data is valuable for operations in extreme climates — capture it on the Fluid entity.

**Expected yield per publication:** 15–25 Fluid entities, 10–20 ALTERNATIVE_FLUID relationships, significant enrichment of existing REQUIRES_FLUID relationships.

---

### 6. Loading Tool Selection Guides (10–30 pages)

**Examples:** Komatsu Loading Tool Selection Guide

**Characteristics:** Focused on matching loading equipment (excavators, shovels, wheel loaders) to haul trucks. Includes sizing charts, productivity calculations, and application-specific recommendations.

**What to extract:**

| Extract | Entity Type | Priority |
|---------|-------------|----------|
| Equipment matching tables | COMPATIBLE_WITH relationships | Critical |
| Productivity data per match | Properties on COMPATIBLE_WITH | High |
| Application recommendations | OperationalContext + SUITED_FOR | Medium |
| Equipment model stubs | Equipment entities | Medium |

**Granularity guidance:**
- These guides are **the definitive source for COMPATIBLE_WITH relationships**. Index every matching combination with full properties (pass count, bucket fill factor, truck capacity, cycle time if available).
- Create Equipment entity stubs for all models mentioned even if you have no other documentation for them. They serve as nodes in the matching graph.

**Expected yield per guide:** 30–80 COMPATIBLE_WITH relationships, 10–20 Equipment entity stubs, 5–10 OperationalContext entities.

---

## Deterministic Extraction Rules (Phase 1 — Haiku-Compatible)

This section provides explicit, mechanical rules for Phase 1 indexing (spec sheets, fluids publication, loading tool selection guide). These rules enable Haiku to execute Phase 1 with high consistency and accuracy without semantic judgment.

### Deduplication Rules

**By Entity Type:**

| Entity Type | Unique Key | Match Criteria | Action |
|-------------|-----------|-----------------|--------|
| **Equipment** | `(modelNumber, manufacturer)` | Compare exact modelNumber string (case-insensitive). If match found, skip creation; enrich existing entity. If no match, create new. | If spec sheet lists variant (e.g., "-6" electric version), create as separate Equipment with `VARIANT_OF` relationship. |
| **Manufacturer** | `name` | Compare manufacturer name (case-insensitive, strip whitespace). If match, skip; reuse GUID. | Use authoritative names (Caterpillar, Komatsu, Hensley). |
| **Component** | `(equipment_id, componentType, location)` | Within the same Equipment, check if Component exists with this type and location. | Top-level systems (engine, hydraulic system, undercarriage) are always created per Equipment. Sub-components (specific pump models, screens) are created once per system, not per equipment. |
| **Fluid** | `(specification, standard)` | Match by **specification** first (e.g., "Cat DEO-ULS 15W-40"), then by **standard** (e.g., "API CK-4"). Include alternative grades in matching (e.g., "15W-40" matches "15W-50" if same API grade). Use ALTERNATIVE_FLUID for documented substitutes. | If source lists both OEM brand and industry standard, create one Fluid entity with industry standard as primary; note OEM brand in description. |
| **Part** | `partNumber` | Exact match on part number string. If no explicit part number (e.g., "M40 tooth"), derive deterministic ID from component + type + size. | Hensley XS 644, ESCO V-Series, MTG brands are separate Part entities but linked via INTERCHANGEABLE_WITH where applicable. |
| **MaintenanceProcedure** | `(equipment_id, intervalHours, taskDescription)` | Maintenance schedules: one MaintenanceProcedure per interval hour per equipment model. De-duplicate by exact interval and task name match. | "500-hour service" on two different manuals = one MaintenanceProcedure linked to both Equipment entities. |
| **FailureMode** | `(component_id, symptoms, rootCause)` | Troubleshooting tables: one FailureMode per unique (symptom, root cause) pair per component. | "Pressure loss in main pump" + "blocked screen" = one FailureMode, reused across all equipment with that pump. |

**Search-before-create discipline:**
Before creating any entity, search the repository using `memory_find_entities` with the appropriate filters (entityType, manufacturer, equipment, etc.). If a matching entity exists, enrich it instead of creating a duplicate.

---

### Extraction Patterns (Mechanical Rules for Structured Data)

**Spec Sheets — Table Parsing:**

1. **Specifications Table:**
   - Column headers: typically "Item", "Unit", "Value" or "Specification", "Value"
   - Row → property on Equipment entity
   - Parse weight as float (MT or tonnes) → `operatingWeight`
   - Parse power as float (kW) → `enginePower`
   - Parse bucket as float (m³) → `bucketCapacity`

2. **Engine Specifications Table:**
   - One row per engine → Component entity
   - Columns: Model, Type, Cylinders, Power, Displacement, Aspiration
   - Parse as: `modelNumber` (part), `componentType` = "engine", `specifications` = `{cylinders: N, displacement: L, aspiration: "turbocharged|naturally-aspirated", powerPerEngine: kW}`

3. **Hydraulic System Table:**
   - Multiple rows (pumps, flows, pressures, circuits)
   - Create: one `hydraulic-system` Component per equipment
   - Create: one `main-pump` sub-component per pump listed (if spec sheet lists 6 pumps, create 6 Part entities or sub-Component entities if no part number)
   - Extract as relationships: `CONTAINS` pump → hydraulic-system, with `quantity` and `position`
   - Extract pressure as property: `reliefPressure` on hydraulic-system

4. **Fluid Capacities Table:**
   - Row per fluid type (hydraulic oil, engine oil, coolant, fuel, grease)
   - Create or link Fluid entity
   - Create `REQUIRES_FLUID` relationship with `capacity` (litres) and `specification` (e.g., "SAE 15W-40 API CK-4")
   - Use standard grade matching: if spec sheet says "engine oil 472 L" without grade, apply heuristic: diesel engines → "SAE 15W-40", gasoline → "SAE 10W-30"

5. **Truck-Shovel Matching Table:**
   - Columns: Truck Model, Payload, Pass Count, Bucket Fill %, Cycle Time
   - Create Equipment entity for truck (if not already indexed)
   - Create `COMPATIBLE_WITH` relationship: shovel → truck
   - Properties: `matchType = "truck-shovel"`, `passCount`, `bucketFillFactor`, `cycleTime`
   - **Chart interpretation warning:** Spec sheets often include truck-shovel matching as a visual chart (bar graph or scatter plot) that flattens badly to text during PDF conversion. The Y-axis is typically **short tons** (payload) with values 0–300+, and the X-axis is **number of passes** with values 3–7. Truck model names (e.g., "730E", "HD1500") appear as chart line labels. **Do not confuse Y-axis tonnage values with pass counts.** Valid pass counts for mining truck-shovel matching are always in the range 3–7. If you extract a passCount above 10, it is almost certainly a Y-axis tonnage label — omit passCount from the properties rather than recording an incorrect value.

**Loading Tool Selection Guide — Matching Tables:**
   - One row = one COMPATIBLE_WITH relationship
   - Columns: Loading Equipment, Haul Truck, Passes, Fill Factor, Production
   - Extract all values; create Equipment stubs for trucks if not already indexed

**Fluids Publication:**
   - Table per fluid type (engine oils, hydraulic oils, coolants, greases)
   - Create Fluid entity per row: `fluidType`, `specification`, `standard`, `viscosityGrade`, `approvedProducts`, `temperatureRange`
   - Create ALTERNATIVE_FLUID relationships where publication lists acceptable substitutes

---

### Entity Creation Ordering (Dependency Graph)

**Phase 1 must follow this strict order** to avoid forward references:

1. **Create Manufacturers first:**
   - Extract all manufacturer names from all spec sheets
   - Create one Manufacturer entity per unique name
   - (Usually: Caterpillar, Komatsu, Hensley, ESCO, MTG)

2. **Create Fluid entities:**
   - Parse entire fluids publication
   - Create one Fluid per unique specification
   - Set relationships to be added later; do not create REQUIRES_FLUID yet
   - (Typically 15–25 fluid entities)

3. **Create Equipment entities** (one per spec sheet):
   - Parse equipment-level specifications
   - Create MANUFACTURED_BY relationship to manufacturer
   - Do not create HAS_COMPONENT yet; collect component data
   - (Typically 20–40 Equipment entities in Phase 1)

4. **Create Component entities** (systems and sub-components):
   - For each Equipment, create top-level systems (engine, hydraulic, undercarriage, etc.)
   - Create sub-components (pumps, screens, coolers) linked via CONTAINS
   - Link to manufacturer if sub-component has manufacturer (e.g., Komatsu engine)
   - (Typically 80–120 Component entities)

5. **Create Part entities** (discrete consumables):
   - GET teeth, filters, seals, track shoes, buckets
   - Match part number globally; do not duplicate
   - (Typically 15–30 Part entities in Phase 1)

6. **Create relationships** in this order:
   - Equipment → Component via HAS_COMPONENT
   - Component → Component via CONTAINS
   - Component → Fluid via REQUIRES_FLUID
   - Component → Part via USES_PART
   - Equipment → Equipment via COMPATIBLE_WITH
   - Equipment → Equipment via VARIANT_OF

**Why this order matters:**
- Manufacturers and fluids are shared; create them once
- Equipment entities must exist before attaching components
- Components must exist before creating relationships
- This prevents failed relationship creation due to missing target entities

---

### Decision Trees for Phase 1 Ambiguities

**Q: Is this a new Component or enrichment of an existing one?**
- A: Within the same Equipment, check ComponentType + location. If (Equipment, componentType="hydraulic-system", location=null) exists → enrich. If not → create.
- Exception: Same component name on different Equipment = separate entities (each Equipment has its own hydraulic system instance).

**Q: Should I create a part or a sub-component?**
- A: If the spec sheet provides a **part number**, create Part. If it provides **model number and specifications** (e.g., "Komatsu SSDA16V159E-3 engine"), create Component with MANUFACTURED_BY.
- Example: "Hensley XS 644 GET teeth" → Part (has part number). "Komatsu SSDA16V159E-3" → Component (has model number and type).

**Q: What if the spec sheet lists multiple engines but the equipment has only one total power rating?**
- A: Create separate Component entities for each engine (e.g., PC7000-11 has two 1,250 kW engines). Set `quantity: 2` on the HAS_COMPONENT relationship. Total power is a calculated property, not stored.

**Q: What if two spec sheets list the same truck for matching, but one says "360-ton truck" and the other says "360E"?**
- A: Treat as the same Equipment if they have matching payload class. Create one Equipment entity with both names as aliases in the description. Link with one COMPATIBLE_WITH relationship per source document.

**Q: How precise should fluid capacities be?**
- A: Extract exact numbers from the source. If source says "hydraulic oil ~9,500 L", store 9500 with a note that it's approximate. If source says "engine oil 472 L", store 472. Do not round.

**Q: A spec sheet lists "engine oil: SAE 15W-40 or equivalent". Should I create two Fluid entities?**
- A: No. Create one Fluid entity for "SAE 15W-40 API CK-4" (the standard). Create a second Fluid for specific OEM brand (e.g., "Cat DEO-ULS") if it's explicitly called out. Link them via ALTERNATIVE_FLUID with a note "OEM equivalent to industry standard".

**Q: The loading tool guide lists truck-shovel matching, but my fleet doesn't operate those trucks. Should I create Equipment stubs anyway?**
- A: Yes. Create Equipment stubs (with minimal properties: modelNumber, equipmentType, manufacturer, approximate weight). They establish nodes in the compatibility graph and can be enriched later if documentation arrives.

---

### Extraction Verification Checkpoints (Phase 1)

After extracting from each document type, verify:

| Document Type | Verification Check |
|---------------|--------------------|
| **Spec sheets** | Every Equipment has HAS_COMPONENT relationships to 5+ major systems (engine, hydraulic, undercarriage, swing, electrical at minimum) |
| **Fluids publication** | Every Fluid entity has a specification property; every Fluid referenced by a spec sheet exists in the repository |
| **Loading tool guide** | Every COMPATIBLE_WITH relationship has passCount and bucketFillFactor properties; no equipment names are dangling (all referenced trucks have Equipment entities) |

If a check fails, re-read the source document and fill the gap before moving to Phase 2.

---

## Phased Indexing Approach

Index documents in this order to build value progressively:

### Phase 1 — Equipment Skeletons (Spec Sheets + Fluids Publication) **[Haiku-Compatible]**

**Goal:** Establish the equipment models, their components, fluid requirements, and truck-shovel matching.

**Documents:** All spec sheets (tier 2) + Cat fluids publication + loading tool selection guide

**Model recommendation:** **Haiku** — Phase 1 is highly structured with deterministic extraction rules defined above. Use the Deterministic Extraction Rules section to guide extraction; no semantic judgment required.

**Why this order:**
- Spec sheets are fast to index and create the equipment scaffold.
- The fluids publication provides the authoritative fluid data to enrich component relationships.
- The selection guide fills in the equipment matching network.
- All three document types contain dense tables that map to mechanical extraction patterns.

**Deliverable:** A queryable graph of equipment models, their component hierarchies, fluid requirements with capacities, parts (GET systems), and truck-shovel compatibility. This alone is enough for fleet-wide procurement queries and equipment matching.

**Verification checkpoint:**
- Every Equipment entity has 5+ HAS_COMPONENT relationships to major systems
- Every REQUIRES_FLUID relationship has capacity and specification properties
- Every COMPATIBLE_WITH relationship (truck-shovel matching) has passCount and bucketFillFactor properties
- Cross-manufacturer fluid queries return results (e.g. "all machines using SAE 15W-40")
- Truck-shovel matching queries return pass counts and cycle times

### Phase 2 — Maintenance and Troubleshooting (O&M Manuals) **[Opus-Recommended]**

**Goal:** Add the maintenance schedule, parts catalog, and troubleshooting layer.

**Documents:** All O&M manuals (tier 1)

**Model recommendation:** **Opus** — O&M manuals contain structured maintenance tables (~60% mechanical extraction) but also require semantic judgment to interpret troubleshooting prose, identify component relationships, and reason about failure mode causation (~40% judgment). Opus's superior reasoning handles the prose sections reliably without false extractions or missed relationships.

**Why this order:**
- O&M manuals are large and time-consuming. Having the equipment scaffold from Phase 1 means you're enriching existing entities rather than creating from scratch.
- Maintenance procedures reference components and fluids that already exist in the graph; Opus can use context from Phase 1 to disambiguate references.

**Structured vs. prose trade-off:**
- Maintenance schedule tables, lubrication charts, and filter lists are mechanical and could be Haiku-extracted in isolation
- Troubleshooting tables (symptom → cause → remedy) require judgment to identify which component is affected and to link to Phase 1 component entities
- Safety procedures and operating notes are generally skipped (not useful in the graph)

**Deliverable:** Full maintenance schedule for each model, filter and wear part catalog, troubleshooting decision support. This enables "what's due at X hours?" and "this component is failing — what do I check?" queries.

**Verification checkpoint:**
- Every Equipment entity with an O&M manual has 20+ MaintenanceProcedure entities linked (8+ service intervals × multiple tasks per interval)
- Maintenance procedures have linked parts and fluids with quantities
- FailureMode entities are connected to components and corrective procedures; at least one FailureMode per major component category
- No orphan MaintenanceProcedure or FailureMode entities
- "What's due at 500h?" queries return 5+ maintenance tasks with associated parts and fluids

### Phase 3 — Fleet Context (Performance Handbooks) **[Opus-Recommended]**

**Goal:** Add the broader fleet context — model lineage, application matching, productivity data, and additional equipment models.

**Documents:** Cat Performance Handbook, Komatsu Performance Handbook

**Model recommendation:** **Opus** — Performance handbooks mix structured tables (equipment specs, matching tables) with prose descriptions of applications and conditions. Opus is better at reasoning about "which equipment suits hard rock vs. soft overburden" and identifying when application contexts require new OperationalContext entities.

**Why this order:**
- Performance handbooks are broad but less deep. They add context and cross-references to the already-rich equipment and maintenance data.
- Model lineage and application data become more valuable once the detailed equipment data exists.
- By Phase 3, the graph has thousands of nodes; Opus's ability to contextualize new data against the existing graph prevents duplicate OperationalContext entities and maintains consistency.

**Deliverable:** Complete fleet knowledge base with equipment selection guidance, application matching, model history, and fleet-wide cross-references.

**Verification checkpoint:**
- OperationalContext entities exist and are linked to Equipment via SUITED_FOR (minimum 10–20 distinct application contexts)
- SUPERSEDES relationships capture model lineage (e.g., PC4000-6 → PC4000-11) with `keyChanges` property
- COMPATIBLE_WITH network is comprehensive across the fleet (loader-truck and shovel-truck matching fully connected)
- Neighborhood exploration (depth 2) from any Equipment entity returns related equipment, compatible partners, and applicable maintenance procedures
- The graph can answer all five demo scenarios from the plan document

---

### Model Selection Summary

| Phase | Primary Documents | Recommended Model | Why | Cost & Schedule |
|-------|-------------------|-------------------|-----|-----------------|
| **Phase 1** | Spec sheets, fluids pub, loading guide | **Haiku** | Highly structured tables; deterministic extraction rules eliminate judgment calls. See "Deterministic Extraction Rules" section above. | Fast + low cost; can parallelize across multiple spec sheets |
| **Phase 2** | O&M manuals (tier 1, large PDFs) | **Opus** | Maintenance tables are mechanical, but troubleshooting prose requires semantic reasoning. Opus reliably interprets symptoms, root causes, and component relationships. | Slower, higher cost, but produces fewer errors and false extractions |
| **Phase 3** | Performance handbooks (tier 1, large PDFs) | **Opus** | Mix of structured matching tables (mechanical) and application prose (requires judgment). Opus reasons about context and prevents duplicate OperationalContext entities. | Higher cost justified by quality; relatively fewer documents (2 handbooks vs 10+ manuals) |

**Cost Estimate:**
- Phase 1 (Haiku): ~$20–30 per handbook (5 spec sheets + fluids publication + matching guide) — **<1 hour total time**
- Phase 2 (Opus): ~$80–120 per manual (5 large PDFs with rich content) — **3–5 hours total time**
- Phase 3 (Opus): ~$100–150 total (2 handbooks) — **2–3 hours total time**

**Phase 1 parallelization:** Because extraction is deterministic, can run Haiku on 2–3 spec sheets in parallel, reducing Phase 1 wall-clock time.

---

## Granularity Decision Guide

Use this guide when deciding how deep to go on a specific piece of content:

| Question | Go Deeper | Keep It Simple |
|----------|-----------|----------------|
| Does a mining maintenance planner care about this? | Yes → create entities and relationships | No → skip or note as property |
| Can this data answer an inventory question? | Yes → create Part and Fluid entities | No → capture as properties |
| Would a technician look this up during a repair? | Yes → create Component, FailureMode, and Procedure entities | No → skip |
| Is this shared across multiple machines? | Yes → create a shared entity and link it | No → capture as property on the specific entity |
| Does this appear in a structured table in the source document? | Yes → probably worth indexing as entities | No → use judgment |
| Is this marketing language or technical data? | Marketing → skip | Technical → index |

### When NOT to index

- **Safety warnings and legal disclaimers** — capture as a `safetyRequirements` property on relevant procedures, not as separate entities.
- **Operating instructions** (how to drive, how to swing) — these are procedural knowledge, not graph knowledge. Exception: pre-operation checks and daily inspections ARE worth indexing as MaintenanceProcedure entities.
- **Dimensional drawings** — capture key dimensions as properties on Equipment or Component entities. Don't create entities for individual dimensions.
- **Marketing claims** — "industry-leading productivity" is not data. "5,000 t/hour at 1.8 t/m³ density" is data.
- **Warranty terms** — outside the scope of this vocabulary. Could be added as a vocabulary extension if needed.

---

## Cross-Manufacturer Indexing Notes

When indexing documentation from multiple manufacturers (e.g. Cat and Komatsu), pay attention to these cross-reference opportunities:

### Fluids
Fluids are the strongest cross-manufacturer link. Both Cat and Komatsu engines use SAE 15W-40 oil meeting API CK-4 (though each may have an OEM-branded product). Index the **industry specification** as the primary Fluid entity and note OEM brand names as properties.

### GET Systems
Ground engaging tools are often sourced from third-party manufacturers (e.g. Hensley, ESCO, MTG). These parts appear across equipment from multiple OEMs. Create Part entities at the GET system level and link them to all buckets that use them.

### Filters
While filter part numbers are typically OEM-specific, the filter specifications (size, micron rating, flow capacity) may match across manufacturers. Use `INTERCHANGEABLE_WITH` relationships to link equivalent filters where cross-references are known.

### Monitoring Systems
Each manufacturer has their own telematics platform (Komtrax Plus for Komatsu, Cat Product Link for Caterpillar). These are separate Component entities, but an `OperationalContext` extension could model fleet management across mixed platforms.

---

## Enrichment Strategy

Not all information is available in the first pass. Plan for enrichment:

1. **Phase 1 creates stubs.** A Component entity created from a spec sheet may have only `componentType` and basic `specifications`. That's fine — it's a node in the graph.
2. **Phase 2 enriches stubs.** O&M manuals add fluid specifications, maintenance intervals, parts lists, and troubleshooting data to existing Component entities. Use `update_entity` to merge new information.
3. **Phase 3 adds context.** Performance handbooks add application data and fleet-wide cross-references.
4. **Ongoing updates.** As new documentation arrives (service bulletins, technical updates, new model releases), the graph grows organically. The `open` governance mode allows new vocabulary terms without approval gates.

Always **search before creating**. The most common indexing error is creating a duplicate entity instead of enriching an existing one.
