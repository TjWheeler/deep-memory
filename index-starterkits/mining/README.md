# Mining Equipment Domain Starter Kit

## Purpose

This starter kit defines a vocabulary and indexing process for building knowledge graphs about **mining equipment, components, parts, fluids, maintenance, and fleet operations**. It is designed to capture the structured knowledge found in equipment spec sheets, operation and maintenance manuals, performance handbooks, and fleet management documentation.

This is a **standalone vocabulary** -- it does not depend on or extend the Person or Conversations starter kits. Manufacturers, equipment, and operational contexts are modeled within this vocabulary.

## Target Use Cases

- **Parts and inventory management** -- identifying shared components, parts, and fluids across a mixed-manufacturer fleet to optimize procurement and stockholding
- **Maintenance planning** -- retrieving scheduled service procedures with required parts, fluids, capacities, and intervals for specific equipment models
- **Troubleshooting and repair** -- navigating from a reported symptom or failure to affected components, root causes, and corrective procedures
- **Equipment matching** -- pairing loading tools (shovels, excavators) with haul trucks by capacity, or identifying compatible attachments for a given machine
- **Fleet-wide analysis** -- aggregating fluid requirements, common failure modes, or maintenance schedules across an entire fleet
- **Operational planning** -- matching equipment to mining applications based on material type, ground conditions, and productivity requirements

## What the Graph Can Answer

Once populated, an agent can answer questions like:

- "Which fluids do I need to stock for my fleet of PC7000-11, PC4000-11, and Cat 325F L? Show total quantities."
- "What components in the PC7000-11 hydraulic system should I check if we're seeing pressure loss?"
- "Which haul trucks are compatible with the PC7000-11 front shovel, and how many passes per truck?"
- "What maintenance is due at 2,000 hours on the Cat 325F L? List procedures, parts, and fluids."
- "Which machines in our fleet share the same engine oil specification?"
- "What are the common failure modes for hydraulic pumps across our Komatsu excavators?"
- "Show me every component that uses Hensley XS 644 GET teeth -- which machines does that affect?"
- "What's the total hydraulic oil capacity across our fleet?"
- "Which equipment models are suited for hard rock extraction in tropical conditions?"
- "What replaced the PC4000-6 in Komatsu's lineup, and what changed?"

## When to Use This Kit

Use this starter kit when:

- The primary subject matter is **mining or heavy equipment** and the operational knowledge around it.
- You need to index **manufacturer documentation** (spec sheets, O&M manuals, performance handbooks) into a queryable knowledge graph.
- You want to enable **cross-referencing across equipment models and manufacturers** -- shared parts, common fluids, compatible equipment.
- You are building a **fleet management knowledge base** for maintenance planning, inventory optimization, or operational decision-making.

This kit is also suitable for adjacent heavy equipment domains (construction, quarrying, earthmoving) with minor vocabulary extensions.

## Governance Recommendation

**`open`** governance is recommended. Mining equipment terminology is extensive and highly varied across manufacturers, model generations, and regional conventions. The agent needs to create new vocabulary terms freely during indexing -- a locked or managed vocabulary would block the indexing flow on every unfamiliar component type or maintenance procedure.

## Design Philosophy

**Model the knowledge structure, not the document layout.** The goal is not to replicate PDF content -- it's to capture the structural knowledge: what components make up this machine, what fluids each system requires, what maintenance procedures apply, how equipment models relate to each other. The documents are the source; the graph is the intelligence layer.

**Go deep on components.** A shallow model ("the PC7000-11 has a hydraulic system") is almost useless for troubleshooting or parts management. A deep model ("the hydraulic system contains 6 main pumps, a load-limiting governor, four circuits, and air-to-oil coolers with temperature-regulated fans") enables an agent to navigate from a symptom to the specific component that needs attention.

**Fluids and parts are first-class citizens.** These are the primary cross-reference entities in a mixed fleet. A single "SAE 15W-40" fluid entity linked to every engine that uses it answers the procurement question directly. A single "Hensley XS 644" GET system entity linked to every bucket that uses it answers the inventory question.

**Relationships carry the operational data.** A `REQUIRES_FLUID` relationship without `capacity` and `changeInterval` properties is incomplete. A `COMPATIBLE_WITH` relationship without `passCount` and `bucketFillFactor` is just a hint. Properties on relationships are what make the graph operationally useful.

**Equipment matching is a graph traversal, not a lookup table.** Rather than storing flat compatibility tables, model the matching criteria as relationships with properties. This allows the agent to reason about trade-offs: "the 360-ton truck takes 4 passes at 90% fill -- the 400-ton truck takes 3 passes at 95% fill."

## Starter Kit Files

| File | Description |
|------|-------------|
| `vocabulary.md` | Entity and relationship type definitions |
| `domain-guidance.md` | Extraction prompt guidance for AI agents |
| `indexing-strategy.md` | Document-specific extraction guidance |
| `validation-rules.json` | Structural validation rules |
| `README.md` | This file |

## Automated Extraction

The `vocabulary.md`, `domain-guidance.md`, and `indexing-strategy.md` files are consumed by the indexing pipeline automatically. No manual copying or configuration is required -- the pipeline reads these files directly from the starter kit directory.

For configuration details and usage, see [docs/indexer-extraction-guide.md](../../docs/indexer-extraction-guide.md).

## Manual Indexing Process (MCP Tools)

Step-by-step guidance for an AI agent indexing mining equipment documentation into a deep-memory repository using MCP tools rather than the automated pipeline.

---

### Prerequisites

- Read `vocabulary.md` in this folder to understand the available entity types and relationship types.
- Read `indexing-strategy.md` for document-specific extraction guidance and granularity decisions.
- Ensure the MCP server is running and accessible.
- Have the source documents available (spec sheets, O&M manuals, performance handbooks) via SharePoint or local filesystem.

---

### Indexing Order

Always follow this sequence. Later steps depend on entities created in earlier steps.

1. Create or open the repository
2. Create Manufacturer entities
3. Create Fluid entities (base fluids from specifications)
4. Create Equipment entities
5. Create Component entities (top-level systems first, then sub-components)
6. Create Part entities
7. Create Equipment -> Component relationships (`HAS_COMPONENT`)
8. Create Component -> Component relationships (`CONTAINS`)
9. Create Component -> Fluid relationships (`REQUIRES_FLUID`)
10. Create Component -> Part relationships (`USES_PART`)
11. Create Equipment -> Equipment relationships (`COMPATIBLE_WITH`, `VARIANT_OF`, `SUPERSEDES`)
12. Create MaintenanceProcedure entities and link to Equipment/Components
13. Create FailureMode entities and link to Components
14. Create OperationalContext entities and link to Equipment
15. Validate and verify the graph

---

### Step 1 -- Create or Open the Repository

If a mining equipment repository already exists, open it. Otherwise, create one.

When creating:
- Choose a descriptive `label` (e.g. "Mining Fleet Knowledge Base" or "Acme Mining Equipment Library").
- Set governance mode to `open`.
- Include the full vocabulary from `vocabulary.md`: all eight entity types and all relationship types.

After creating, verify by listing repositories or getting stats.

---

### Step 2 -- Create Manufacturer Entities

Create one Manufacturer entity per OEM encountered in the source documents. These are the most reusable entities -- they'll be referenced by Equipment and Component entities across the entire graph.

#### Common manufacturers to create upfront

| Label | shortName | country |
|-------|-----------|---------|
| Caterpillar Inc. | Cat | United States |
| Komatsu Ltd. | Komatsu | Japan |

#### Deduplication

Before creating a Manufacturer, search by label or shortName. Manufacturers are shared across the entire repository -- duplicates cause fragmented queries.

---

### Step 3 -- Create Fluid Entities

Create Fluid entities for the standard fluids referenced across all equipment. Fluids are identified by **specification**, not brand name.

#### Why fluids are created early

Fluids are the primary cross-reference entity. Creating them before Equipment and Component entities means they're available immediately when building `REQUIRES_FLUID` relationships. Deduplication is critical -- a single "SAE 15W-40" entity must be reused across all engines that require it.

#### Common mining equipment fluids

| Label | fluidType | specification | standard |
|-------|-----------|---------------|----------|
| SAE 15W-40 | engine-oil | SAE 15W-40 | API CK-4 |
| SAE 10W-30 | engine-oil | SAE 10W-30 | API CK-4 |
| ISO VG 46 | hydraulic-oil | ISO VG 46 | |
| ISO VG 68 | hydraulic-oil | ISO VG 68 | |
| SAE 30 | transmission-oil | SAE 30 | Cat TO-4 |
| SAE 80W-90 | gear-oil | SAE 80W-90 | API GL-5 |
| 50/50 ELC | coolant | 50/50 Extended Life Coolant | Cat ELC |
| NLGI 2 EP Grease | grease | NLGI 2 | |
| HFC-134a | refrigerant | HFC-134a | |
| Diesel No. 2 | fuel | Ultra-low sulfur diesel | ASTM D975 |
| DEF/AdBlue | def | ISO 22241 | ISO 22241 |

Don't create all fluids upfront -- only create those you encounter in the documents. The list above is a starting reference. As you index more documents, new fluid specifications will appear (OEM-specific grades, specialty greases, etc.) -- create them as needed.

---

### Step 4 -- Create Equipment Entities

Create one Equipment entity per distinct model found in the source documents.

#### Creating Equipment

1. **One entity per model.** "Komatsu PC7000-11" is one entity. If the same model has distinct configurations (front shovel vs backhoe), create one base Equipment entity -- the configurations are handled via Component entities and `HAS_COMPONENT` with a `configuration` property.
2. Set `modelNumber` exactly as stated by the manufacturer.
3. Set `equipmentType` from recommended values.
4. Populate all specification properties where data is available (weight, power, capacity, etc.).
5. Write a meaningful summary that includes the equipment class and key capability.

#### Linking Equipment to Manufacturer

Create `MANUFACTURED_BY` from Equipment -> Manufacturer immediately after creating the Equipment entity.

#### Deduplication

Before creating an Equipment entity, search by `modelNumber`. The same model may appear in multiple source documents (spec sheet, performance handbook, O&M manual) -- merge information into one entity, don't create duplicates.

---

### Step 5 -- Create Component Entities

This is the most important step for graph depth and utility. Create components at **two levels**:

#### Level 1 -- Top-level systems

For each Equipment entity, create Component entities for the major systems:

| componentType | What to capture |
|---------------|-----------------|
| `engine` | Model number, power, cylinders, aspiration, rpm -- create as many as the equipment has (e.g. 2 engines for the PC7000-11) |
| `hydraulic-system` | Total flow, pressure, circuit description |
| `undercarriage` | Track shoe count, roller count, track width |
| `swing-system` | Motor count, gear count, ring type |
| `cab` | Suspension type, HVAC, controls |
| `electrical-system` | Voltage, batteries, alternator |
| `lubrication-system` | Auto-lube type, capacity, pump count |
| `cooling-system` | Coolant capacity, fan type |
| `fuel-system` | Tank capacity, filter stages |
| `monitoring-system` | System name (e.g. Komtrax Plus, Cat Product Link) |

#### Level 2 -- Sub-components

Within each top-level system, create sub-Component entities for the specific assemblies and parts that the source document describes:

| Parent system | Sub-components to capture |
|---------------|---------------------------|
| `hydraulic-system` | Main pumps (with model number, flow rate), swing motors, oil coolers, high pressure screens, control valves |
| `engine` | Turbocharger, fuel injection system, aftertreatment (DPF, SCR) |
| `undercarriage` | Individual track shoe type, rollers, idlers, sprockets, track adjustment mechanism |
| `bucket` | GET system (teeth, adapters, shrouds), cutting edge, wear package |
| `lubrication-system` | Pump assemblies, grease containers, Wiggins connections |

#### Linking components

- Create `HAS_COMPONENT` from Equipment -> each Level 1 Component.
- Create `CONTAINS` from Level 1 Component -> each Level 2 sub-Component.
- Create `MANUFACTURED_BY` from Component -> Manufacturer where the component maker is identified (often the same as the equipment OEM, but not always -- e.g. Hensley GET on Komatsu machines).

---

### Step 6 -- Create Part Entities

Create Part entities for specific replaceable or consumable items identified in the source documents.

#### What qualifies as a Part

- Items with manufacturer part numbers
- Ground engaging tools (teeth, adapters, shrouds, cutting edges)
- Filter elements (hydraulic, engine oil, fuel, air, coolant)
- Wear items (track shoes, track pins, brake pads, wiper blades)
- Seals and gaskets mentioned in maintenance procedures

#### Deduplication

Parts are heavily shared across equipment models. Before creating a Part, search by `partNumber` or label. A "Hensley XS 644" GET tooth appears on multiple Komatsu excavator buckets -- it should be one entity referenced by all of them.

---

### Step 7 -- Create Fluid Relationships

Now that Components exist, create the `REQUIRES_FLUID` relationships:

1. For each Component that uses a fluid (engines, hydraulic systems, transmissions, cooling systems, lubrication systems, air conditioning):
   - Create `REQUIRES_FLUID` from Component -> Fluid
   - **Always include `capacity`** -- this is the most important property for fleet-wide procurement queries
   - Include `changeInterval` and `sampleInterval` where the source document provides them

2. Cross-check: after creating all fluid relationships, query each Fluid entity's relationships to verify it has at least one inbound `REQUIRES_FLUID`. Orphan fluids indicate either a missing component or a premature fluid creation.

---

### Step 8 -- Create Part Relationships

Create `USES_PART` from Component -> Part:

1. For each Component that has replaceable parts:
   - Link to the Part entity with `quantity` (e.g. 6 teeth per bucket) and `wearInterval` where known
   - Set `position` if the part location is specific (e.g. "left bank", "primary stage")

---

### Step 9 -- Create Equipment-to-Equipment Relationships

#### COMPATIBLE_WITH (truck-shovel matching)

For spec sheets that include truck compatibility data:
1. Create the haul truck Equipment entities if they don't already exist (e.g. Komatsu 730E, 830E, 930E, 960E)
2. Create `COMPATIBLE_WITH` from excavator -> truck with:
   - `matchType: truck-shovel`
   - `passCount` (e.g. 3, 4, or 5 passes)
   - `bucketFillFactor` (e.g. `90%`, `95%`, `100%`)
   - `truckCapacity` (e.g. `240 short tons`)

#### VARIANT_OF

For equipment with electric drive options or different attachment configurations:
1. Create the variant Equipment entity (e.g. "Komatsu PC7000-11E")
2. Create `VARIANT_OF` from variant -> base model with `variantType`

#### SUPERSEDES

When a document identifies that a model replaces a previous generation:
1. Create both Equipment entities
2. Create `SUPERSEDES` from new -> old with `keyChanges`

---

### Step 10 -- Create MaintenanceProcedure Entities

Extract maintenance procedures from O&M manuals:

1. Create one MaintenanceProcedure entity per distinct maintenance action.
2. Set `intervalHours` and/or `intervalCalendar` from the maintenance schedule tables.
3. Link to Equipment or Component via `HAS_MAINTENANCE`.
4. Link to Fluid via `REQUIRES_FLUID` with `quantity` (how much fluid this procedure consumes).
5. Link to Part via `REQUIRES_PART` with `quantity`.

#### Deduplication for shared procedures

Some procedures are generic across models (e.g. "daily walk-around inspection", "weekly greasing"). Create one procedure and link it to all applicable Equipment/Component entities. Model-specific procedures (e.g. "Cat 325F L hydraulic oil change -- 240 L") should be separate entities with specific quantities.

---

### Step 11 -- Create FailureMode Entities

Extract failure modes from troubleshooting sections in O&M manuals:

1. Create one FailureMode entity per distinct failure pattern.
2. Link to Component via `SUSCEPTIBLE_TO` with `likelihood` and `operatingConditions`.
3. Link to MaintenanceProcedure via `ADDRESSES` (from procedure -> failure mode) with `preventive` or `corrective`.
4. Create `CAUSED_BY` between failure modes where causal chains exist (e.g. "contaminated oil" `CAUSED_BY` "failed filter").
5. Create `INDICATES` from failure mode -> component for diagnostic navigation.

---

### Step 12 -- Create OperationalContext Entities

Extract application data from performance handbooks and selection guides:

1. Create OperationalContext entities for each mining application described.
2. Link to Equipment via `SUITED_FOR` with `productivity` and `limitations`.

---

### Step 13 -- Validate and Verify

#### Structural Validation

After completing the index, run these checks:

1. **Equipment completeness** -- every Equipment entity must have:
   - At least one `MANUFACTURED_BY` relationship
   - At least one `HAS_COMPONENT` relationship
   - A populated `equipmentType` property

2. **Component connectivity** -- every Component entity must have:
   - At least one inbound `HAS_COMPONENT` or `CONTAINS` relationship (no orphan components)
   - At least one outbound relationship (`REQUIRES_FLUID`, `USES_PART`, or `CONTAINS`) where applicable

3. **Fluid coverage** -- every Fluid entity must have at least one inbound `REQUIRES_FLUID` relationship. Orphan fluids indicate premature creation or missing component linkage.

4. **No orphan entities** -- run `get_stats` and verify that no entity type has entities with zero relationships.

#### Neighborhood Exploration

Use `explore_neighborhood` (depth 2) on a central Equipment entity to confirm the graph is well-connected. You should see:

- Equipment -> Manufacturer (via `MANUFACTURED_BY`)
- Equipment -> Components (via `HAS_COMPONENT`)
- Components -> Sub-components (via `CONTAINS`)
- Components -> Fluids (via `REQUIRES_FLUID`)
- Components -> Parts (via `USES_PART`)
- Equipment -> Compatible equipment (via `COMPATIBLE_WITH`)

#### Cross-Reference Verification

Test these specific query patterns:

1. **Fleet-wide fluid query:** Pick a common fluid (e.g. "SAE 15W-40") and traverse inbound `REQUIRES_FLUID` relationships -- you should see components from multiple equipment models and manufacturers.
2. **Truck-shovel matching:** Pick an excavator and traverse `COMPATIBLE_WITH` -- you should see truck models with pass counts.
3. **Component drill-down:** Pick an equipment model, traverse `HAS_COMPONENT` to a top-level system, then traverse `CONTAINS` to sub-components -- verify two levels of depth.

---

### Worked Example -- Indexing the Komatsu PC7000-11 Spec Sheet

Given the PC7000-11 spec sheet content:

#### Manufacturers
1. Create Manufacturer: "Komatsu" (shortName: Komatsu, country: Japan)
2. Create Manufacturer: "Hensley" (for GET system)

#### Equipment
3. Create Equipment: "Komatsu PC7000-11" (equipmentType: hydraulic-excavator, operatingWeight: "682 MT", enginePower: "2,500 kW (3,350 HP)", bucketCapacity: "38 m3 (49.4 yd3)", swingSpeed: "3.1 rpm", travelSpeed: "2.5 km/h", fuelCapacity: "13,310 L", tier: "Tier 4", electricDriveAvailable: true)
4. Create `MANUFACTURED_BY`: PC7000-11 -> Komatsu

#### Top-Level Components
5. Create Component: "Engine: SSDA16V159E-3" (componentType: engine, modelNumber: "SSDA16V159E-3", specifications: "16-cylinder, 4-cycle, turbocharged and aftercooled, 1,250 kW (1,500 HP) @ 1800 rpm", quantity: 2)
6. Create Component: "Hydraulic System" (componentType: hydraulic-system, capacity: "9,500 L total system", pressure: "310 bar")
7. Create Component: "Undercarriage" (componentType: undercarriage, specifications: "48 track shoes per side, 7 bottom rollers, 3 top rollers, automatic hydraulic track adjustment")
8. Create Component: "Swing System" (componentType: swing-system, specifications: "2 hydraulic motors and swing gears, external ring teeth, 3.1 rpm max")
9. Create Component: "Operator Cab" (componentType: cab, specifications: "Enclosed steel cab on viscous pads, automatic A/C, electro-hydraulic joystick controls")
10. Create Component: "Electrical System" (componentType: electrical-system, specifications: "24V system, 4x 12V batteries, 2x 260A alternator, 12 LED work lights")
11. Create Component: "Lubrication System" (componentType: lubrication-system, specifications: "3 Lincoln single-line auto-lube systems, 900 L total capacity")
12. Create Component: "Monitoring System: Komtrax Plus" (componentType: monitoring-system, specifications: "Real-time and stored operating status, fault messages, ORBCOMM/Iridium satellite optional")
13. Create Component: "Front Shovel Attachment" (componentType: attachment, specifications: "Boom 8,000 mm, Stick 5,500 mm, Breakout 2,023 kN, Crowd 2,151 kN")
14. Create Component: "Backhoe Attachment" (componentType: attachment, specifications: "Boom 11,000 mm, Stick 5,100 mm, Breakout 1,648 kN, Tear-out 1,473 kN")

#### HAS_COMPONENT relationships
15. Create `HAS_COMPONENT`: PC7000-11 -> Engine (quantity: 2)
16. Create `HAS_COMPONENT`: PC7000-11 -> Hydraulic System
17. Create `HAS_COMPONENT`: PC7000-11 -> Undercarriage
18. Create `HAS_COMPONENT`: PC7000-11 -> Swing System
19. Create `HAS_COMPONENT`: PC7000-11 -> Cab
20. Create `HAS_COMPONENT`: PC7000-11 -> Electrical System
21. Create `HAS_COMPONENT`: PC7000-11 -> Lubrication System
22. Create `HAS_COMPONENT`: PC7000-11 -> Monitoring System
23. Create `HAS_COMPONENT`: PC7000-11 -> Front Shovel (configuration: "front shovel")
24. Create `HAS_COMPONENT`: PC7000-11 -> Backhoe (configuration: "backhoe")

#### Sub-Components
25. Create Component: "Main Hydraulic Pumps" (componentType: hydraulic-pump, modelNumber: "Komatsu", capacity: "6,210 L/min (1,640 gpm)", quantity: 6)
26. Create Component: "High Pressure Screens" (componentType: hydraulic-filter, specifications: "200 microns")
27. Create Component: "Air-to-Oil Hydraulic Coolers" (componentType: hydraulic-cooler, specifications: "Large swing-out vertical, temperature-regulated hydraulically driven fans")
28. Create Component: "Bucket: 38 m3 Front Shovel" (componentType: bucket, specifications: "Width 5,208 mm, 6 teeth, max material density 1.8 t/m3")
29. Create Component: "Track Shoes: 1,500 mm" (componentType: track-shoe, dimensions: "1,500 mm (59 in)")
30. Create Component: "Track Shoes: 1,900 mm" (componentType: track-shoe, dimensions: "1,900 mm (75 in)")
31. Create Component: "DEF Tank" (componentType: fuel-system, capacity: "514 L (136 gal)", specifications: "Tier 4 only")

#### CONTAINS relationships
32. Create `CONTAINS`: Hydraulic System -> Main Hydraulic Pumps (quantity: 6)
33. Create `CONTAINS`: Hydraulic System -> High Pressure Screens
34. Create `CONTAINS`: Hydraulic System -> Air-to-Oil Hydraulic Coolers
35. Create `CONTAINS`: Front Shovel -> Bucket: 38 m3 Front Shovel
36. Create `CONTAINS`: Undercarriage -> Track Shoes: 1,500 mm (quantity: 96, position: "48 per side, standard")
37. Create `CONTAINS`: Undercarriage -> Track Shoes: 1,900 mm (quantity: 96, position: "48 per side, wide option")

#### Parts
38. Create Part: "Hensley XS 644 GET Tooth" (partType: get-tooth, getSystem: "Hensley XS 644")
39. Create `USES_PART`: Bucket -> Hensley XS 644 (quantity: 6)
40. Create `MANUFACTURED_BY`: Hensley XS 644 -> Hensley

#### Fluids
41. Create or reuse Fluid: "SAE 15W-40" (engine-oil)
42. Create or reuse Fluid: "ISO VG 46" or equivalent (hydraulic-oil)
43. Create or reuse Fluid: "HFC-134a" (refrigerant)
44. Create or reuse Fluid: "Diesel No. 2" (fuel)
45. Create or reuse Fluid: "DEF/AdBlue" (def)
46. Create or reuse Fluid: "NLGI 2 EP Grease" (grease)

#### REQUIRES_FLUID relationships
47. Create `REQUIRES_FLUID`: Engine -> SAE 15W-40 (capacity: "472 L (124 US gal)", specification: "API CK-4")
48. Create `REQUIRES_FLUID`: Hydraulic System -> Hydraulic Oil (capacity: "9,500 L (2,510 US gal)")
49. Create `REQUIRES_FLUID`: Engine -> Coolant (capacity: "880 L (232 US gal)")
50. Create `REQUIRES_FLUID`: PC7000-11 -> Fuel (capacity: "13,310 L (3,516 US gal)")
51. Create `REQUIRES_FLUID`: Lubrication System -> Grease (capacity: "900 L (238 US gal)")
52. Create `REQUIRES_FLUID`: DEF Tank -> DEF (capacity: "514 L (136 gal)")
53. Create `REQUIRES_FLUID`: Cab (A/C) -> HFC-134a (capacity: "5.5-10.0 kg")

#### Truck-Shovel Compatibility
54. Create Equipment: "Komatsu 730E" (equipmentType: haul-truck, operatingWeight: "240 short tons")
55. Create Equipment: "Komatsu 830E" (equipmentType: haul-truck)
56. Create Equipment: "Komatsu 930E" (equipmentType: haul-truck)
57. Create Equipment: "Komatsu 960E" (equipmentType: haul-truck)
58. Create `MANUFACTURED_BY` for each truck -> Komatsu
59. Create `COMPATIBLE_WITH`: PC7000-11 -> 730E (matchType: truck-shovel, passCount: 5, bucketFillFactor: "90%")
60. Create `COMPATIBLE_WITH`: PC7000-11 -> 830E (matchType: truck-shovel, passCount: 4, bucketFillFactor: "90%")
61. Create `COMPATIBLE_WITH`: PC7000-11 -> 930E (matchType: truck-shovel, passCount: 4, bucketFillFactor: "90%")
62. Create `COMPATIBLE_WITH`: PC7000-11 -> 960E (matchType: truck-shovel, passCount: 3, bucketFillFactor: "90%")

#### Verification
63. Run `get_stats` -- expect: ~1 Equipment + 4 trucks, ~15 Components, ~6 Fluids, ~1 Part, 2 Manufacturers, 60+ relationships
64. Run `explore_neighborhood` on PC7000-11 (depth 2) -- verify full connectivity
65. Test: "Which fluids does the PC7000-11 need?" -- traverse outward from PC7000-11 through components to fluids
66. Test: "Which trucks match the PC7000-11?" -- traverse `COMPATIBLE_WITH` from PC7000-11
