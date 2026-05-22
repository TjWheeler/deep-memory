# Mining Equipment Domain — Vocabulary

This document defines the entity types and relationship types for a mining equipment knowledge graph. It is intended to be read by AI agents and human developers when creating or extending a repository for equipment management, fleet operations, and maintenance planning.

---

## Patterns in This Vocabulary

Before reading the full spec, understand these seven conventions. When extending this vocabulary with new types, follow the same patterns for consistency.

1. **Component hierarchy uses `CONTAINS` relationships.** Equipment is composed of systems, systems contain sub-components, sub-components contain parts. This hierarchy is modeled with `HAS_COMPONENT` (Equipment → Component) and `CONTAINS` (Component → Component). Always create both levels where the source data supports it — shallow graphs are useless for troubleshooting.

2. **Fluids and parts are shared entities, not properties.** A fluid like "SAE 15W-40 engine oil" exists once in the graph and is linked to every component that uses it. This enables fleet-wide queries: "total hydraulic oil needed across all machines." Never duplicate a fluid or part entity — always deduplicate by specification or part number first.

3. **Operational data lives on relationships, not just entities.** A `REQUIRES_FLUID` relationship must carry `capacity` and `changeInterval` where known. A `COMPATIBLE_WITH` relationship must carry `passCount` and `bucketFillFactor`. Without these properties, the relationship is a hint rather than actionable intelligence.

4. **Specifications are properties on entities.** Operating weight, bucket capacity, engine power, flow rates — these are properties on Equipment and Component entities, not separate Specification entities. This keeps the graph lean and makes filtering straightforward.

5. **Equipment variants share a base via `VARIANT_OF`.** A diesel PC7000-11 and an electric PC7000-11E are separate Equipment entities linked by `VARIANT_OF`. Each carries its own specifications. Don't try to model variants as properties on a single entity — the spec differences are too significant.

6. **Recommended values, not enums.** Properties like `equipmentType`, `componentType`, `fluidType`, `procedureType`, and `failureType` list recommended values but accept any string. Mining equipment taxonomy is vast — use a new value when none of the recommendations fit.

7. **Labels and summaries enable efficient retrieval.** Every entity must have a concise label and a one-line summary. When an agent searches for "hydraulic pump" and gets 15 results, it's the labels and summaries that let it pick the right ones without loading full details. Follow the conventions consistently.

---

## Entity Types

### Equipment

A specific equipment model — not an individual serial-numbered machine, but a model that represents all machines of that type. For example, "Komatsu PC7000-11" represents all PC7000-11 excavators.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `modelNumber` | string | yes | Manufacturer's model designation (e.g. `PC7000-11`, `325F L`, `9020XPC`) |
| `equipmentType` | string | yes | See recommended values below |
| `operatingWeight` | string | no | With units (e.g. `682 MT`, `25,600 kg`) |
| `enginePower` | string | no | Total rated power with units (e.g. `2,500 kW (3,350 HP)`) |
| `bucketCapacity` | string | no | Standard bucket volume (e.g. `38 m³ (49.4 yd³)`) |
| `maxDiggingDepth` | string | no | Maximum digging depth with units |
| `maxDumpingHeight` | string | no | Maximum dumping height with units |
| `maxDiggingReach` | string | no | Maximum digging reach with units |
| `groundPressure` | string | no | Ground pressure with units (e.g. `25.3 N/cm²`) |
| `travelSpeed` | string | no | Maximum travel speed (e.g. `2.5 km/h`) |
| `swingSpeed` | string | no | Maximum swing speed (e.g. `3.1 rpm`) |
| `fuelCapacity` | string | no | Usable fuel tank volume with units |
| `productionYearStart` | string | no | Year production began |
| `productionYearEnd` | string | no | Year production ended (omit if current) |
| `tier` | string | no | Emissions tier (e.g. `Tier 4`, `Tier 2`) |
| `electricDriveAvailable` | boolean | no | Whether an electric drive variant exists |

**Label convention:** `{Manufacturer} {modelNumber}` (e.g. "Komatsu PC7000-11", "Cat 325F L").

**Summary convention:** A one-line description including type, class, and key capability, e.g. "682-tonne class hydraulic mining excavator with 38 m³ bucket capacity and 2,500 kW engine power."

**Recommended `equipmentType` values:**

| Value | Description |
|-------|-------------|
| `hydraulic-excavator` | Track-mounted hydraulic excavator (mining or construction class) |
| `wheel-loader` | Rubber-tired front-end loader |
| `haul-truck` | Off-highway rigid or articulated dump truck |
| `dozer` | Track-type or wheel-type bulldozer |
| `dragline` | Walking dragline excavator |
| `grader` | Motor grader |
| `drill` | Blast-hole or exploration drill rig |
| `crusher` | Mobile or semi-mobile crushing plant |
| `conveyor` | Overland or in-pit conveyor system |
| `water-truck` | Water cart for dust suppression |
| `service-truck` | Mobile maintenance and lubrication vehicle |
| `cable-shovel` | Electric rope shovel |
| `scraper` | Self-loading or towed scraper |
| `compact-excavator` | Mini/midi hydraulic excavator (under 10 tonnes) |
| `compact-track-loader` | Compact track loader (rubber or steel tracks, loader bucket) |
| `landfill-compactor` | Steel-wheeled compactor for landfill or waste applications |
| `material-handler` | Wheeled material handler with elevated cab and grab attachment |

---

### Manufacturer

An equipment, component, or parts manufacturer.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | string | yes | Full company name (e.g. "Caterpillar Inc.", "Komatsu Ltd.") |
| `shortName` | string | no | Common abbreviation (e.g. "Cat", "Komatsu") |
| `country` | string | no | Country of headquarters |
| `website` | string | no | Primary website URL |
| `divisions` | string | no | Relevant business divisions (e.g. "Komatsu Mining Corp", "Cat Mining") |

**Label convention:** The `shortName` if set, otherwise `name` (e.g. "Komatsu", "Caterpillar").

**Summary convention:** A one-line description, e.g. "Japanese manufacturer of mining and construction equipment, headquartered in Tokyo."

---

### Component

A named system, sub-system, or assembly within an equipment model. Components form a hierarchy: an equipment model `HAS_COMPONENT` top-level systems, and systems `CONTAINS` sub-components.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `componentType` | string | yes | See recommended values below |
| `modelNumber` | string | no | Manufacturer's part or model number for this component (e.g. `SSDA16V159E-3`) |
| `specifications` | string | no | Key specifications in structured text (e.g. `16-cylinder, 4-cycle, turbocharged, 1,250 kW @ 1800 rpm`) |
| `quantity` | number | no | How many of this component per equipment unit (e.g. 2 engines, 6 pumps) |
| `capacity` | string | no | Volume, flow rate, or capacity with units (e.g. `6,210 L/min`, `9,500 L`) |
| `pressure` | string | no | Operating or relief pressure with units (e.g. `310 bar`) |
| `weight` | string | no | Component weight with units |
| `material` | string | no | Primary material or construction (e.g. `hardened steel`, `cast iron`) |
| `serviceable` | boolean | no | Whether this component is field-serviceable |

**Label convention:** `{componentType}: {modelNumber or descriptive name}` (e.g. "Engine: SSDA16V159E-3", "Hydraulic Pump: Main Pump Assembly", "Track Shoe: 1,500 mm").

**Summary convention:** A one-line description including key specs, e.g. "16-cylinder turbocharged diesel engine rated at 1,250 kW (1,500 HP) at 1,800 rpm, one of two in the PC7000-11 powertrain."

**Recommended `componentType` values:**

| Value | Description |
|-------|-------------|
| `engine` | Internal combustion engine (diesel, gas, dual-fuel) |
| `electric-motor` | Electric drive motor |
| `hydraulic-pump` | Main or auxiliary hydraulic pump |
| `hydraulic-system` | Complete hydraulic circuit including pumps, valves, coolers |
| `hydraulic-cylinder` | Individual hydraulic actuator |
| `hydraulic-valve` | Control valve, relief valve, or check valve |
| `hydraulic-cooler` | Oil cooler or heat exchanger |
| `transmission` | Gearbox, torque converter, or power-shift transmission |
| `final-drive` | Track or wheel final drive assembly |
| `undercarriage` | Complete undercarriage system (tracks, rollers, idlers, sprockets) |
| `track-frame` | Track frame and associated structure |
| `track-shoe` | Individual track shoe or pad |
| `track-roller` | Top or bottom track roller |
| `idler` | Front or rear track idler |
| `sprocket` | Drive sprocket |
| `swing-system` | Swing motor, gear, ring, and brakes |
| `swing-ring` | Slewing ring bearing |
| `boom` | Excavator boom |
| `stick` | Excavator stick/arm |
| `bucket` | Digging, loading, or clean-up bucket |
| `bucket-teeth` | Ground engaging tools (GET) on the bucket |
| `wear-package` | Bucket or lip wear protection |
| `cab` | Operator cabin and controls |
| `air-conditioning` | HVAC system for operator cab |
| `electrical-system` | Batteries, alternator, wiring, lighting |
| `lubrication-system` | Centralized auto-lube system |
| `fuel-system` | Fuel tank, lines, filters, injection |
| `cooling-system` | Radiator, coolant circuit, fan |
| `air-intake` | Air filtration and intake system |
| `exhaust-system` | Exhaust manifold, muffler, aftertreatment (DPF, SCR, DEF) |
| `fire-suppression` | On-board fire detection and suppression system |
| `monitoring-system` | Telematics, payload monitoring, health monitoring (e.g. Komtrax Plus, Cat Product Link) |
| `counterweight` | Machine counterweight |
| `attachment` | Generic attachment (ripper, quick coupler, thumb, etc.) |

---

### Part

A discrete replaceable or consumable item. Parts are typically referenced by manufacturer part numbers and are the atomic level of the inventory management use case.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `partNumber` | string | no | Manufacturer or aftermarket part number |
| `partType` | string | yes | See recommended values below |
| `material` | string | no | Primary material (e.g. `hardened steel`, `polyester/cellulose`, `rubber`) |
| `dimensions` | string | no | Key dimensions with units |
| `weight` | string | no | Weight with units |
| `wearLife` | string | no | Expected service life (e.g. `500 hours`, `2,000 hours`, `seasonal`) |
| `specifications` | string | no | Key specifications in structured text (e.g. tooth size, material grade, pressure rating) |
| `getSystem` | string | no | Ground engaging tool system name (e.g. `Hensley XS 644`, `Cat K Series`) |
| `crossReference` | string | no | Equivalent part numbers from other manufacturers |

**Label convention:** `{partType}: {partNumber or descriptive name}` (e.g. "GET Tooth: Hensley XS 644", "Hydraulic Filter: 207-60-71182", "Track Shoe: 1,500 mm HD").

**Summary convention:** A one-line description, e.g. "Hensley XS 644 ground engaging tooth for 38 m³ bucket, 6 teeth per bucket, heavy-duty mining application."

**Recommended `partType` values:**

| Value | Description |
|-------|-------------|
| `get-tooth` | Ground engaging tool — bucket tooth or point |
| `get-adapter` | GET adapter that holds the tooth |
| `get-shroud` | Lip or side shroud for bucket wear protection |
| `wear-plate` | Wear liner or chocky bar |
| `cutting-edge` | Bucket cutting edge or bolt-on edge |
| `hydraulic-filter` | Hydraulic oil filter element |
| `engine-oil-filter` | Engine oil filter element |
| `fuel-filter` | Primary or secondary fuel filter element |
| `air-filter` | Engine or cab air filter element |
| `coolant-filter` | Coolant conditioning filter |
| `def-filter` | Diesel exhaust fluid (DEF/AdBlue) filter element |
| `hydraulic-seal` | O-ring, seal kit, or packing for hydraulic cylinders |
| `track-shoe` | Individual track shoe or pad |
| `track-bolt` | Track shoe bolt and nut |
| `track-link` | Track chain link |
| `track-pin` | Track pin and bushing |
| `roller` | Top or bottom roller (as replacement part) |
| `idler` | Front or rear idler (as replacement part) |
| `sprocket-segment` | Replaceable sprocket tooth segment |
| `belt` | Drive belt, fan belt, alternator belt |
| `hose` | Hydraulic, coolant, or air hose |
| `gasket` | Engine or system gasket |
| `bearing` | Roller, ball, or plain bearing |
| `brake-pad` | Service or parking brake friction material |
| `wiper-blade` | Cab windshield wiper |
| `light-bulb` | Work light, indicator, or headlight bulb/LED |

---

### Fluid

A specific fluid, lubricant, coolant, refrigerant, or consumable chemical used in equipment operation and maintenance. Fluids are identified by industry specifications (SAE, ISO, API, OEM) and are the primary cross-reference for fleet-wide procurement.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `fluidType` | string | yes | See recommended values below |
| `specification` | string | yes | Industry or OEM specification (e.g. `SAE 15W-40`, `ISO VG 46`, `Cat HYDO Advanced 10`) |
| `viscosityGrade` | string | no | SAE or ISO viscosity grade |
| `standard` | string | no | Governing standard (e.g. `API CK-4`, `Cat ECF-3`, `Komatsu KES 07.868.1`) |
| `temperatureRange` | string | no | Recommended operating temperature range |
| `color` | string | no | Fluid color for field identification |
| `mixable` | boolean | no | Whether this fluid can be mixed with other brands meeting the same spec |
| `environmentalRating` | string | no | Biodegradability or environmental classification |

**Label convention:** `{specification}` or `{fluidType}: {specification}` (e.g. "SAE 15W-40", "Hydraulic Oil: ISO VG 46", "Coolant: Cat ELC").

**Summary convention:** A one-line description, e.g. "SAE 15W-40 diesel engine oil meeting API CK-4 and Cat ECF-3 specifications, suitable for all Cat and most Komatsu diesel engines."

**Recommended `fluidType` values:**

| Value | Description |
|-------|-------------|
| `engine-oil` | Diesel or gas engine crankcase oil |
| `hydraulic-oil` | Hydraulic system fluid |
| `transmission-oil` | Transmission and drive train fluid |
| `gear-oil` | Final drive and differential gear oil |
| `coolant` | Engine coolant / antifreeze |
| `grease` | Chassis, bearing, or open gear grease |
| `fuel` | Diesel fuel, biodiesel blend |
| `def` | Diesel exhaust fluid (AdBlue/DEF for SCR systems) |
| `refrigerant` | Air conditioning refrigerant |
| `brake-fluid` | Hydraulic brake fluid |
| `compressor-oil` | Air compressor lubricant |
| `coolant-additive` | Supplemental coolant additive (SCA) or conditioner |

---

### MaintenanceProcedure

A scheduled, condition-based, or corrective maintenance task. Each procedure is a discrete action that can be assigned, tracked, and costed.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `procedureType` | string | yes | See recommended values below |
| `description` | string | yes | What the procedure involves in plain language |
| `intervalHours` | number | no | Service interval in operating hours (e.g. `500`, `2000`) |
| `intervalCalendar` | string | no | Calendar-based interval (e.g. `daily`, `weekly`, `monthly`, `annual`, `seasonal`) |
| `estimatedDuration` | string | no | Estimated time to complete (e.g. `30 minutes`, `4 hours`, `1 shift`) |
| `skillLevel` | string | no | `operator`, `mechanic`, `specialist`, `oem-technician` |
| `safetyRequirements` | string | no | Safety precautions, lockout/tagout requirements |
| `specialTools` | string | no | Special tools or equipment required |
| `referenceDocument` | string | no | Source document and section reference |

**Label convention:** `{procedureType}: {short description}` (e.g. "Oil Change: Engine oil and filter replacement", "Inspection: Daily walk-around", "Rebuild: Hydraulic pump overhaul").

**Summary convention:** A one-line description, e.g. "Replace engine oil and filters every 500 hours using SAE 15W-40 oil (472 L total capacity across both engines), including drain, refill, and filter replacement."

**Recommended `procedureType` values:**

| Value | Description |
|-------|-------------|
| `inspection` | Visual or instrument-based check (daily walk-around, periodic inspection) |
| `oil-change` | Drain and refill oil (engine, hydraulic, transmission, gear) |
| `filter-change` | Replace filter element(s) |
| `lubrication` | Grease or oil application to specific points |
| `adjustment` | Tension, alignment, clearance, or calibration adjustment |
| `replacement` | Swap a worn or damaged component or part |
| `rebuild` | Strip, inspect, replace worn internals, reassemble |
| `overhaul` | Complete disassembly, inspection, and rebuild to as-new condition |
| `cleaning` | System flush, screen cleaning, radiator washdown |
| `sampling` | Oil, coolant, or wear particle sampling for condition monitoring |
| `testing` | Pressure test, flow test, electrical test, load test |
| `software-update` | Controller firmware, monitoring system, or telematics update |
| `calibration` | Payload system, pressure sensor, or instrument calibration |

---

### FailureMode

A known failure pattern, fault condition, or degradation mechanism that affects a component. Failure modes connect symptoms to root causes and link to corrective procedures.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `failureType` | string | yes | See recommended values below |
| `description` | string | yes | What fails and how it manifests |
| `symptoms` | string | no | Observable symptoms (e.g. "excessive heat, reduced cycle time, unusual noise") |
| `rootCause` | string | no | Underlying cause if known (e.g. "contaminated hydraulic oil", "worn pump internals") |
| `severity` | string | no | `critical` (machine down), `major` (reduced performance), `minor` (degraded but operational), `monitoring` (trend to watch) |
| `diagnosticMethod` | string | no | How to confirm this failure (e.g. "pressure test at port X", "oil sample analysis", "visual inspection") |
| `mtbf` | string | no | Mean time between failures if known |
| `preventable` | boolean | no | Whether preventive maintenance can avoid this failure |

**Label convention:** `{failureType}: {short description}` (e.g. "Leak: Hydraulic cylinder rod seal failure", "Wear: Bucket tooth worn beyond service limit").

**Summary convention:** A one-line description, e.g. "Hydraulic cylinder rod seal failure causing external oil leak at boom cylinder, typically caused by contaminated oil or scored rod, correctable by seal kit replacement."

**Recommended `failureType` values:**

| Value | Description |
|-------|-------------|
| `wear` | Normal or accelerated wear beyond service limit |
| `leak` | Fluid leak — hydraulic, coolant, oil, fuel |
| `overheating` | Component or system exceeding temperature limits |
| `contamination` | Fluid or system contamination (particles, water, wrong fluid) |
| `fatigue` | Metal fatigue, cracking, or fracture |
| `corrosion` | Rust, oxidation, or chemical attack |
| `electrical` | Wiring, sensor, controller, or solenoid failure |
| `seizure` | Bearing, pin, or mechanical seizure |
| `cavitation` | Hydraulic pump or cylinder cavitation damage |
| `misalignment` | Shaft, track, or structural misalignment |
| `blockage` | Filter clogging, screen blockage, port obstruction |
| `vibration` | Excessive vibration indicating imbalance or looseness |
| `software` | Controller fault, sensor drift, calibration loss |

---

### OperationalContext

A mining application, material type, or set of operating conditions that affect equipment selection and performance. These entities enable "which machine for which job" queries.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `applicationType` | string | yes | See recommended values below |
| `materialType` | string | no | Material being handled (e.g. `coal`, `iron ore`, `overburden`, `copper ore`, `gold ore`) |
| `materialDensity` | string | no | Typical material density with units (e.g. `1.8 t/m³`) |
| `conditions` | string | no | Operating conditions (e.g. `wet tropical`, `arid`, `frozen ground`, `high altitude`) |
| `benchHeight` | string | no | Typical bench height for this application |
| `haulDistance` | string | no | Typical haul distance |
| `productionTarget` | string | no | Target production rate (e.g. `10,000 t/hour`) |

**Label convention:** `{applicationType}: {materialType or description}` (e.g. "Overburden Removal: Coal mine topsoil", "Primary Loading: Iron ore").

**Summary convention:** A one-line description, e.g. "Coal overburden removal in wet tropical conditions with 1.4 t/m³ material density, 12 m bench height, and 2 km haul distance."

**Recommended `applicationType` values:**

| Value | Description |
|-------|-------------|
| `primary-loading` | Loading haul trucks from the dig face |
| `overburden-removal` | Stripping waste material to expose ore |
| `ore-extraction` | Digging and loading ore material |
| `stockpile-rehandling` | Moving material from stockpiles |
| `bench-preparation` | Leveling and preparing benches |
| `road-maintenance` | Haul road grading and maintenance |
| `drainage` | Pit dewatering and drainage work |
| `rehabilitation` | Site rehabilitation and backfilling |
| `demolition` | Structure or infrastructure demolition |
| `trenching` | Utility or drainage trench excavation |

---

### Attachment

A tool or work implement that mounts to equipment to perform a specific task. Attachments are distinct from components — they are interchangeable, task-specific, and often shared across equipment models (e.g. a ripper, quick coupler, or demolition shear).

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `attachmentType` | string | yes | See recommended values below |
| `modelNumber` | string | no | Manufacturer's model designation |
| `operatingWeight` | string | no | Attachment weight with units |
| `capacity` | string | no | Volume, force, or size rating with units (e.g. `1.2 m³`, `50 kN`) |
| `compatibility` | string | no | Equipment class or size range this attachment fits (e.g. `20–30 tonne excavators`) |
| `mountType` | string | no | Mounting interface (e.g. `S-type coupler`, `pin-on`, `ISO 13031`) |

**Label convention:** `{attachmentType}: {modelNumber or descriptive name}` (e.g. "Ripper: Single Shank HD", "Quick Coupler: CW-45s", "Bucket: 1.2 m³ GP").

**Summary convention:** A one-line description, e.g. "Single-shank heavy-duty ripper for 30–50 tonne excavators, pin-on mount, 1,200 kg operating weight."

**Recommended `attachmentType` values:**

| Value | Description |
|-------|-------------|
| `ripper` | Single or multi-shank ripper for rock or frozen ground |
| `quick-coupler` | Hydraulic or mechanical quick coupler for tool changes |
| `grapple` | Sorting, demolition, or log grapple |
| `hammer` | Hydraulic breaker or rock hammer |
| `shear` | Demolition or scrap shear |
| `compactor` | Plate or wheel compactor attachment |
| `auger` | Earth or rock auger |
| `thumb` | Hydraulic thumb for material handling |
| `tilt-rotator` | Tilt and rotate coupler for precision work |
| `bucket` | Attachment bucket (GP, HD, rock, ditching, tilt) — use when the bucket is an interchangeable attachment rather than a fixed component |

---

## Relationship Types

### Core Relationships

**Cross-Entity Manufacturing Link:**

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `MANUFACTURED_BY` | Equipment, Component, Part, or Attachment is made by this manufacturer | Equipment/Component/Part/Attachment → Manufacturer | no |

**Equipment Relationships:**

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `HAS_COMPONENT` | Equipment contains this top-level system or assembly | Equipment → Component | no |
| `COMPATIBLE_WITH` | Equipment is operationally matched with another equipment or attachment | Equipment/Attachment → Equipment/Attachment | yes |
| `VARIANT_OF` | Equipment is a variant of another model (e.g. electric vs diesel, different attachment config) | Equipment → Equipment | no |
| `SUPERSEDES` | This model replaces a previous generation | Equipment → Equipment | no |
| `SUITED_FOR` | Equipment is suitable for this operational context | Equipment → OperationalContext | no |

#### Properties for `HAS_COMPONENT`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `quantity` | number | no | How many of this component (e.g. 2 engines, 6 pumps) |
| `location` | string | no | Where on the machine (e.g. "left powertrain", "front attachment") |
| `configuration` | string | no | Attachment or variant-specific note (e.g. "front shovel only", "backhoe only") |

#### Properties for `COMPATIBLE_WITH`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `matchType` | string | no | Type of compatibility — `truck-shovel`, `attachment`, `tool-carrier` |
| `passCount` | number | no | Number of loading passes to fill (for truck-shovel matching) |
| `bucketFillFactor` | string | no | Assumed bucket fill percentage (e.g. `90%`, `95%`, `100%`) |
| `truckCapacity` | string | no | Truck payload capacity for this match |
| `notes` | string | no | Additional matching notes or conditions |

#### Properties for `VARIANT_OF`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `variantType` | string | no | Nature of the variation (e.g. `electric-drive`, `backhoe-configuration`, `high-altitude`, `cold-weather`) |

#### Properties for `SUPERSEDES`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `effectiveDate` | string | no | ISO 8601 date — when the new model replaced the old |
| `reason` | string | no | Why the model was superseded (e.g. "emissions compliance", "performance upgrade") |
| `keyChanges` | string | no | Summary of what changed between generations |

#### Properties for `SUITED_FOR`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `productivity` | string | no | Expected productivity in this context (e.g. `5,000 t/hour`, `2,500 bcm/hour`) |
| `efficiency` | string | no | Fuel or energy efficiency in this context |
| `limitations` | string | no | Any constraints or limitations in this application |

---

### Component Relationships

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `CONTAINS` | This component contains a sub-component | Component → Component | no |
| `REQUIRES_FLUID` | This component requires a specific fluid | Component → Fluid | no |
| `USES_PART` | This component uses a specific replaceable part | Component → Part | no |

#### Properties for `CONTAINS`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `quantity` | number | no | How many (e.g. 6 pumps in the hydraulic system) |
| `position` | string | no | Location within the parent component (e.g. "inlet side", "left bank") |

#### Properties for `REQUIRES_FLUID`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `capacity` | string | yes | Volume required with units (e.g. `472 L`, `9,500 L`) |
| `specification` | string | no | Required fluid specification (e.g. `Cat DEO-ULS`, `API CK-4`) |
| `changeInterval` | string | no | Recommended change interval (e.g. `500 hours`, `2,000 hours`, `annual`) |
| `sampleInterval` | string | no | Oil/coolant sampling interval (e.g. `250 hours`) |

#### Properties for `USES_PART`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `quantity` | number | no | How many per component (e.g. 6 teeth per bucket) |
| `position` | string | no | Where on the component |
| `wearInterval` | string | no | Expected replacement interval (e.g. `200 hours`, `seasonal`) |

---

### Maintenance Relationships

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `HAS_MAINTENANCE` | This equipment or component has this scheduled procedure | Equipment/Component → MaintenanceProcedure | no |
| `REQUIRES_FLUID` | This procedure requires a specific fluid | MaintenanceProcedure → Fluid | no |
| `REQUIRES_PART` | This procedure requires a specific part | MaintenanceProcedure → Part | no |
| `ADDRESSES` | This procedure addresses (prevents or corrects) a failure mode | MaintenanceProcedure → FailureMode | no |

#### Properties for `HAS_MAINTENANCE`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `intervalHours` | number | no | Hours interval for this procedure on this equipment |
| `priority` | string | no | `critical`, `standard`, `recommended` |
| `source` | string | no | Source document and section |

#### Properties for `REQUIRES_FLUID` (on MaintenanceProcedure)

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `quantity` | string | no | Amount needed for this procedure (e.g. `472 L`, `50 L`) |
| `purpose` | string | no | What the fluid is used for in this procedure (e.g. `refill`, `flush`, `top-up`) |

#### Properties for `REQUIRES_PART` (on MaintenanceProcedure)

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `quantity` | number | no | How many needed per service event |
| `notes` | string | no | Part-specific instructions |

#### Properties for `ADDRESSES`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `preventive` | boolean | no | `true` if this procedure prevents the failure mode |
| `corrective` | boolean | no | `true` if this procedure corrects the failure mode |
| `effectivenessNotes` | string | no | How effective the procedure is at addressing the failure |

---

### Failure Relationships

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `SUSCEPTIBLE_TO` | This component is susceptible to this failure mode | Component → FailureMode | no |
| `CAUSED_BY` | This failure mode can be caused by another failure | FailureMode → FailureMode | no |
| `INDICATES` | This failure mode indicates a problem with a specific component | FailureMode → Component | no |

#### Properties for `SUSCEPTIBLE_TO`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `likelihood` | string | no | `common`, `occasional`, `rare` |
| `operatingConditions` | string | no | Conditions that increase susceptibility (e.g. "dusty environment", "cold start", "overloading") |
| `earlyWarning` | string | no | What to monitor for early detection |

#### Properties for `CAUSED_BY`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `mechanism` | string | no | How the upstream failure causes the downstream failure |

#### Properties for `INDICATES`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `diagnosticMethod` | string | no | How to confirm (e.g. "pressure test", "visual inspection", "oil sample") |
| `confidence` | string | no | `high`, `medium`, `low` — how reliably this failure points to the component |

---

### Cross-Reference Relationships

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `INTERCHANGEABLE_WITH` | This part can be substituted with another | Part → Part | yes |
| `ALTERNATIVE_FLUID` | This fluid can be substituted with another under conditions | Fluid → Fluid | yes |

#### Properties for `INTERCHANGEABLE_WITH`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `conditions` | string | no | Conditions under which the substitution is valid |
| `notes` | string | no | Any caveats or differences |
| `source` | string | no | Who authorized the interchange (OEM, aftermarket, field-proven) |

#### Properties for `ALTERNATIVE_FLUID`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `conditions` | string | no | When the alternative is acceptable (e.g. "emergency only", "tropical climates") |
| `notes` | string | no | Mixing compatibility, transition requirements |

---

## Design Notes

- **Equipment entities are models, not serial-numbered machines.** The "Komatsu PC7000-11" entity represents all machines of that model. Individual fleet tracking (serial numbers, site assignments, hour meters) is outside the scope of this vocabulary — it belongs in a fleet management system that references the knowledge graph.
- **Component depth matters.** Always create sub-components where the source data supports it. A "hydraulic system" entity connected to "main pump", "swing motor", "oil cooler", "high pressure screen" entities is dramatically more useful than a standalone "hydraulic system" entity.
- **Fluids are identified by specification, not brand.** "SAE 15W-40 engine oil meeting API CK-4" is the entity, not "Cat DEO-ULS 15W-40". Brand names can be captured in properties or notes, but the specification is the label. This enables cross-manufacturer queries.
- **Attachments are not components.** A bucket as a fixed part of the machine is a Component linked via `HAS_COMPONENT`. A bucket that can be swapped between machines is an Attachment linked via `COMPATIBLE_WITH`. Use the source document's context to decide.
- **`COMPATIBLE_WITH` is bidirectional.** If the PC7000-11 is compatible with the 930E truck, the reverse is also true. Create it once in either direction. This also applies to Equipment ↔ Attachment compatibility.
- **`INTERCHANGEABLE_WITH` is bidirectional.** Create it once. The graph engine traverses both ways.
- **`VARIANT_OF` is directional.** Create from the variant to the base model (e.g. PC7000-11E `VARIANT_OF` PC7000-11).
- **Maintenance procedures are shared where appropriate.** A "daily walk-around inspection" procedure may apply to multiple equipment models. Deduplicate — create one procedure entity and link it to each Equipment or Component that uses it.
- **Relationship types are normalized** to `SCREAMING_SNAKE_CASE` by the core library.
- **This vocabulary is extensible.** In `open` governance mode, common extensions may include `REPLACED_BY` (part supersession), `TESTED_WITH` (validated fluid or part combinations), `MONITORED_BY` (component to monitoring system), `DOCUMENTED_IN` (link to source document), and `OPERATES_WITH` (equipment that works together in a fleet context beyond truck-shovel matching).

---

## Vocabulary Version History

### Version 1.7.0 — Phase 1 Mining Equipment Indexing (2026-04-02)

**Tested and validated** through extraction and indexing of Komatsu mining excavator specification sheets (PC7000-11, PC4000-11) and related technical documentation.

**Entity types extended:**
- **Equipment:** Added properties for `swingSpeed`, `travelSpeed`, `fuelCapacity`, `tier`, `electricDriveAvailable`, `maxDiggingDepth`, `maxDumpingHeight`, `maxDiggingReach`, `groundPressure`, `productionYearStart`, `productionYearEnd`
- **Component:** Added properties for `pressure`, `weight`, `material`, `serviceable`
- **Part:** Added properties for `specifications`, `getSystem`, `crossReference`
- **Manufacturer:** Introduced as a new entity type for equipment, component, and parts manufacturers

**Relationship types added:**
- `MANUFACTURED_BY` (Equipment/Component/Part → Manufacturer) — consolidated cross-entity manufacturing relationships
- `CONTAINS` (Component → Component) — for sub-component hierarchies
- `REQUIRES_FLUID` (Component → Fluid) — for fluid dependencies with capacity and change intervals
- `USES_PART` (Component → Part) — for replaceable and consumable parts with wear intervals

**Governance mode:** `open` — vocabulary automatically approves new types and deduplicates common values
