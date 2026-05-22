# Mining Equipment Domain — Domain Guidance

This document provides domain-specific knowledge for AI agents extracting entities and relationships from mining equipment documentation. It supplements the vocabulary (what to extract) and the indexing strategy (how to extract) with knowledge about how the mining equipment domain actually works — naming conventions, model numbering systems, and common patterns that prevent extraction errors.

This guidance is injected into the extraction prompt alongside the vocabulary. Follow it when making labeling, grouping, and relationship decisions.

---

## Identity Pattern

This domain does **not** use Identity entities for Equipment, Component, or Fluid types — model designations like "Cat 793F" are globally unique labels. However, if this vocabulary is extended for **fleet management** (tracking individual machines on a site), individual Vehicle entities would need Identity nodes with properties like `serialNumber` and `registrationNumber` to distinguish multiple machines of the same model. See `docs/identity-pattern.md` for the full pattern.

---

## Entity Naming Rules

These rules produce consistent, canonical labels that prevent orphan relationships across documents.

### Equipment Labels

**Format:** `{Full Manufacturer Name} {Model Number}`

Always use the manufacturer's full trade name, not abbreviations:

| Correct | Incorrect |
|---------|-----------|
| `Caterpillar 325F L` | `Cat 325F L` |
| `Caterpillar 789D` | `CAT 789D` |
| `Komatsu PC7000-11` | `PC7000-11` |
| `P&H 4100XPC` | `4100XPC` |

Short forms like "Cat" are legitimate aliases that users search for — add them to the `aliases` array, not the label.

**Model number format:** Use the manufacturer's own designation exactly as printed. Preserve spaces, hyphens, and suffixes:
- `325F L` (not `325FL`)
- `PC7000-11` (not `PC7000`)
- `307.5` (not `307`)

**Do NOT group models in a single entity label.** Each distinct model gets its own entity. `Cat 312F` and `Cat 313F` are separate entities even if they appear in the same table. If the source document groups them (e.g., "312F/313F series"), create separate entities and link with `VARIANT_OF` if appropriate.

**Equipment category labels use plural form:**

| Correct | Incorrect |
|---------|-----------|
| `Caterpillar Hydraulic Excavators` | `Caterpillar Hydraulic Excavator` |
| `Caterpillar Motor Graders` | `Caterpillar Motor Grader` |
| `Caterpillar Articulated Trucks` | `Caterpillar Articulated Truck` |

### Component Labels

**Format:** `{Descriptive Name}` — use proper case, no slug-style formatting.

| Correct | Incorrect |
|---------|-----------|
| `Hydraulic System` | `hydraulic-system` |
| `Swing Bearing` | `swing-ring` |
| `Track Roller` | `track-roller` |
| `Diesel Particulate Filter` | `exhaust-system: DPF` |

Do NOT use the `componentType` slug as a label prefix. The vocabulary's `componentType` field (`hydraulic-system`, `swing-ring`, etc.) is a classification value, not a label format. Labels are human-readable proper names.

When a document names a specific component model, include it: `Engine: SSDA16V159E-3`, `Hydraulic Pump: A8V200`, `Monitor: Komtrax Plus`.

### Fluid Labels

**Format:** `{OEM Brand or Industry Spec}` — use the most specific name from the source document.

| Correct | Incorrect |
|---------|-----------|
| `Cat DEO-ULS` | `Engine Oil` |
| `Cat HYDO Advanced 10` | `Hydraulic Oil` |
| `SAE 15W-40` | `15W-40` |

When a source document names an OEM product (e.g., `Cat DEO-ULS SAE 15W-40`), use the OEM product name as the label. The industry specification (`SAE 15W-40`, `API CK-4`) goes in properties.

### Maintenance Procedure Labels

**Format:** `{Procedure Type}: {Short Description}`

| Correct | Incorrect |
|---------|-----------|
| `Inspection: Daily walk-around` | `Daily walk-around inspection` |
| `Oil Change: Engine oil and filter` | `Engine Oil Change` |
| `Replacement: Hydraulic filter element` | `Filter replacement: Hydraulic` |

### Failure Mode Labels

**Format:** `{Failure Type}: {Short Description}`

| Correct | Incorrect |
|---------|-----------|
| `Leak: Hydraulic cylinder rod seal` | `Hydraulic Leak` |
| `Wear: Bucket tooth worn beyond limit` | `Bucket Tooth Wear` |
| `Contamination: Water in fuel system` | `Water in Fuel` |

---

## Relationship Referencing Rules

**Every `sourceLabel` and `targetLabel` in a relationship MUST exactly match the `label` of an entity you have created.** This is the single most important rule for preventing orphan relationships.

When creating a relationship:
1. Check the entity label you assigned earlier in this extraction
2. Use that exact label in `sourceLabel` or `targetLabel`
3. Do NOT use short forms, aliases, or alternate names in relationships

Example — if you created an entity with label `Caterpillar 325F L`:
- Relationship sourceLabel: `Caterpillar 325F L` (correct)
- Relationship sourceLabel: `Cat 325F L` (WRONG — creates orphan)
- Relationship sourceLabel: `325F L` (WRONG — creates orphan)

**When referencing entities from a previous extraction chunk:** Use the canonical label from the progressive context provided. Do not invent new labels for entities that already exist.

---

## Mining Equipment Model Numbering

Understanding model numbers helps you create accurate entities and avoid incorrect groupings.

### Caterpillar (Cat)

**Pattern:** `{Model Number}{Generation Letter} {Suffix}`

| Component | Meaning | Example |
|-----------|---------|---------|
| Model number | Base model series | `325`, `789`, `994` |
| Generation letter | Design generation (A–F typical) | `325F`, `789D` |
| Suffix: `L` | Long undercarriage | `325F L` |
| Suffix: `LCR` | Low-clearance reduced tail swing | `325F LCR` |
| Suffix: `GC` | General Construction (lighter duty) | `320 GC` |
| Prefix: `M` | **Material handler** (wheeled, purpose-built for scrap/waste) | `M316F` |
| Suffix: `MH` | Material handler variant | `322D2 MH` |
| Suffix: `UHD` | Ultra-high demolition | `345 UHD` |
| Suffix: `XE` | Hybrid/advanced powertrain | `349F XE` |
| Suffix: `RR` | Road rail variant | `311D RR` |

**Important:** `Cat 316F` (standard excavator) and `Cat M316F` (material handler) are **different machines**. Do not map one to the other. Similarly, `Cat 320D2` (excavator) and `Cat M320D2` (material handler) are distinct entities.

### Komatsu

**Pattern:** `PC{Class}{Generation}-{Series}`

| Component | Meaning | Example |
|-----------|---------|---------|
| `PC` | Power Class (hydraulic excavator) | `PC7000` |
| Class number | Operating weight class in tonnes | `7000` = 700-tonne class |
| Generation | Design generation | `-11` is newer than `-6` |
| Suffix: `D` | Diesel drive | `PC7000-11 D` |
| Suffix: `E` | Electric drive | `PC7000-11 E` |

Other prefixes: `WA` (wheel loader), `HD` (haul truck), `D` (dozer), `HM` (articulated truck).

### P&H / Komatsu Mining

**Pattern:** `{Series}{Size}XPC`

| Component | Meaning | Example |
|-----------|---------|---------|
| Series | Product line | `4100`, `2800`, `1900` |
| `XPC` | Extended Performance Capability | `4100XPC` |

---

## Document-Type Entity Expectations

When extracting from a document type, expect to create these entity types. If a document references an entity type that you haven't created, it likely needs a stub entity.

| Document Type | Primary Entities | Also Creates |
|---------------|-----------------|--------------|
| **Spec sheet** | Equipment, Component | Fluid (stubs), Part, Manufacturer |
| **O&M manual** | MaintenanceProcedure, FailureMode | Component (enrichment), Fluid, Part |
| **Performance handbook** | Equipment (many models), OperationalContext | Attachment, Component (stubs) |
| **Fluids publication** | Fluid | **Component (stubs for systems that use fluids)** |
| **Product brochure** | Equipment (stubs) | Component (high-level) |
| **Loading tool selection guide** | Equipment (stubs for trucks) | OperationalContext |

**Fluids publications require special attention:** These documents describe which fluids go in which systems (engine, hydraulic system, cooling system, transmission, etc.). The systems are referenced in relationships but may not have been extracted as entities. **Create Component stub entities for every system referenced in a REQUIRES_FLUID or HAS_MAINTENANCE relationship.** Common stubs needed:

- `Diesel Engine`, `Cooling System`, `Fuel System`, `Hydraulic System`
- `SCR System`, `DEF System`, `Aftertreatment System`
- `Final Drive`, `Transmission`, `Swing Drive`

**O&M manuals that cover multiple models:** When a manual covers a product range (e.g., "Cat 307.5/308/309/310"), create separate Equipment entities for each model. Create relationships from the specific model, not from a generic product line name.

---

## Anti-Hallucination Rules

These rules exist because extraction models have been observed fabricating plausible-sounding values that are not in the source document. This is the most serious extraction error — a wrong value is worse than a missing value.

### Rule 1: If the source doesn't state it, OMIT the property entirely

Do NOT fill in values you "know" from general knowledge. Common hallucination patterns observed:

| Property | Hallucination Example | Why It Happens |
|----------|-----------------------|----------------|
| `operatingWeight` | Inserting a weight for a model you know about | The model "knows" the weight but the source table has a different value or doesn't list it |
| `estimatedDuration` | "30 minutes" for a filter change | Plausible estimate but not stated in the source |
| `temperatureRange` | Merging two rows into one range | The model "simplifies" per-grade data into one value |
| Summary details | "optimum layer depth 0.45-0.5 m" | The model adds technical details it knows about the equipment type |

**Test:** For every property value, ask: "Can I point to the exact line number in the source that states this?" If no, omit the property.

### Rule 2: Never add aliases from general knowledge

An alias must appear **in this source document** as an alternative name for the entity. Do NOT add model generation predecessors, marketing names, or names from other documents as aliases.

- `826H` is NOT an alias for `826K` — they are different model generations
- `Cat 325F` is NOT an alias for `Caterpillar 325F L` unless the source uses both forms

### Rule 3: Per-configuration values stay separate

When a table lists values per configuration (front shovel vs backhoe, different shoe widths, different viscosity grades), extract them as separate values or note the configuration. Do NOT merge them into a single range.

| Wrong | Right |
|-------|-------|
| `temperatureRange: "-10°C to 40°C"` (merged from 15W-40 and 10W-30 rows) | `temperatureRange: "-10°C to 50°C (SAE 15W-40)"` or list both grades separately |
| `groundPressure: "17.5-22.2 N/cm²"` (merged front shovel + backhoe) | `groundPressure: "17.5-21.8 N/cm² (front shovel), 17.7-22.2 N/cm² (backhoe)"` |

### Rule 4: Distinguish weight types

Mining equipment documentation uses several weight measurements. Use the correct property and note the type:

| Source Column Header | Correct Property | Notes |
|---------------------|-----------------|-------|
| "Operating Weight" | `operatingWeight` | Includes fuel, operator, standard equipment |
| "Shipping Weight" / "Shipping Wt." | Do NOT map to `operatingWeight` | Use a `shippingWeight` property or note in summary |
| "Maximum Machine Weight" | `operatingWeight` is acceptable | Note it includes all options |
| "Approx. Operating Weight" | `operatingWeight` | Note the approximation |

---

## Equipment Classification Guide

These classifications are frequently confused during extraction. Use the source document's own description, not your judgment about what the machine "looks like."

### equipmentType — Common Mistakes

| Machine | Correct Type | Wrong Type | How to Tell |
|---------|-------------|------------|-------------|
| Cat 279C, 289C, 299C | `compact-track-loader` | `compact-excavator` | Source says "Compact Track Loader" — these have a loader bucket, not an excavator boom |
| Cat 826K, 836K | `landfill-compactor` | `wheel-loader` | Source says "Landfill Compactor" — these have steel wheels for compaction |
| Cat M316F, M320D2 | `material-handler` | `hydraulic-excavator` | The M prefix = material handler (wheeled, elevated cab, orange-peel grab) |

**Rule:** Read the document's own classification for the machine. Use that, not what the model number pattern suggests.

### partType — Common Mistakes

| Part | Correct Type | Wrong Type | How to Tell |
|------|-------------|------------|-------------|
| DEF filter | `def-filter` | `hydraulic-filter` | Source says "Diesel Exhaust Fluid Filter" |
| Coolant filter | `coolant-filter` | `hydraulic-filter` | Part description references coolant system |
| Cab air filter | `air-filter` | `engine-air-filter` | Filters cab air, not engine intake |

### fluidType — Common Mistakes

| Fluid Specification | Correct Type | Wrong Type | How to Tell |
|--------------------|-------------|------------|-------------|
| Cat ECF-1-a, ECF-2, ECF-3 | `engine-oil` | `coolant` | ECF = Engine Crankcase Fluid (oil spec). Despite the confusing name, these are API CH-4 / CK-4 engine oil categories |
| Cat ELC | `coolant` | `engine-oil` | ELC = Extended Life Coolant |
| Cat SCA | `coolant-additive` | `coolant` | SCA = Supplemental Coolant Additive (additive, not the coolant itself) |

---

## Common Extraction Pitfalls

These are patterns that consistently produce errors. Avoid them.

### 1. Compatibility tables reference individual models

Performance handbooks and spec sheets contain attachment compatibility tables that list individual model numbers (e.g., `Cat 312F`, `Cat 316F`). These models may not appear elsewhere in the document as standalone entities.

**Rule:** For every model number in a compatibility table, create a stub Equipment entity with at minimum `modelNumber` and `equipmentType`. Then the COMPATIBLE_WITH relationship has a valid target.

### 2. Generic system names in relationships

O&M manuals and fluids publications reference systems by short names in relationship context: "Hydraulic System requires Cat HYDO Advanced 10." But the Component entity may have a longer qualified name.

**Rule:** When creating the relationship, use the exact entity label you created, not the short form from the document text. If you haven't created a Component for that system, create a stub first.

### 3. Chunk boundary label drift

In large documents split across multiple chunks, the same entity may be referenced with slightly different names in different sections. The first chunk might establish `Caterpillar 325F L` but a later chunk might reference `Cat 325F L` or `325F Excavator`.

**Rule:** When progressive context provides a list of previously extracted entities, always reuse the existing label exactly. Check the context before creating what might be a duplicate with a different name.

### 4. Grouped model entities from tables

Tables sometimes list related models together: "325B/C/D", "312F/313F". Do not create a single entity with a combined label.

**Rule:** Create separate entities for each model in the group. If the table doesn't provide per-model data, create stubs with shared properties.

### 5. Material handler confusion

Caterpillar uses the `M` prefix for material handlers (e.g., `M316F`, `M320D2`). These are distinct machines from the standard excavator line (`316F`, `320D2`). They have different undercarriages (wheeled vs tracked), different booms, and different applications.

**Rule:** Never map a standard model to a material handler or vice versa. `Cat 316F` and `Cat M316F` are separate entities.

---

## Mining Domain Terminology

Key terms that help with accurate extraction:

| Term | Meaning | Extraction Impact |
|------|---------|-------------------|
| **GET** | Ground Engaging Tools (bucket teeth, adapters, shrouds) | Part entities, not Component |
| **O&M** | Operation & Maintenance (manual type) | Primary source for MaintenanceProcedure |
| **DPF** | Diesel Particulate Filter (exhaust aftertreatment) | Component entity |
| **SCR** | Selective Catalytic Reduction (uses DEF/AdBlue) | Component entity |
| **DEF** | Diesel Exhaust Fluid (AdBlue in EU) | Fluid entity |
| **SCA** | Supplemental Coolant Additive | Fluid entity |
| **ELC** | Extended Life Coolant | Fluid entity |
| **Tier 4** | US EPA emissions standard (strictest current tier) | Property on Equipment |
| **Front shovel** | Excavator with upward-digging bucket | Configuration, not separate model |
| **Backhoe** | Excavator with downward-digging bucket | Configuration, not separate model |
| **Pass count** | Number of bucket loads to fill a haul truck | Property on COMPATIBLE_WITH |
| **Bench height** | Height of the working face in open-pit mining | Property on OperationalContext |
| **BCM** | Bank Cubic Meters (material volume in undisturbed state) | Unit in productivity data |
