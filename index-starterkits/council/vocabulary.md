# Council Planning Domain — Vocabulary

This document defines the entity types and relationship types for a local government planning knowledge graph. It is intended to be read by AI agents and human developers when creating or extending a repository for council planning scheme data, development control policies, and community infrastructure planning.

---

## Patterns in This Vocabulary

Before reading the full spec, understand these seven conventions. When extending this vocabulary with new types, follow the same patterns for consistency.

1. **Planning instruments are the authority source.** Every provision traces back to a `PlanningInstrument` (scheme, policy, or strategy). The instrument is the legal authority for the rule. Always link provisions to their source instrument via `CONTAINS_PROVISION`.

2. **Provisions are the atomic rules.** A single planning scheme clause or policy requirement is modeled as a `Provision` entity. Provisions carry the measurable standards (setbacks, heights, densities) as properties. One section of a planning document may generate multiple provisions — split by scope.

3. **Zones are the spatial organizer.** Most planning rules apply within one or more zones. The `APPLIES_IN` relationship connects provisions to zones. Permissibility of land uses is modeled as `PERMITS` from zone to land use with a `permissibility` property.

4. **Structure types unify physical elements.** Dwellings, outbuildings, signs, jetties, and other built forms are all `StructureType` entities. This allows a single `REGULATES` relationship pattern to connect provisions to any physical structure they control.

5. **Hierarchy levels organize community infrastructure.** Population-based service tiers (local, neighbourhood, district, etc.) are `HierarchyLevel` entities linked to `CommunityFacility` types via `REQUIRES_FACILITY`. This enables population-driven infrastructure planning queries.

6. **Precincts capture location-specific exceptions.** Named geographic areas with special provisions (heritage areas, canal estates, marina precincts) are `Precinct` entities. Provisions that apply only in a specific precinct use `APPLIES_IN_PRECINCT` rather than `APPLIES_IN` (zone-wide).

7. **Labels and summaries enable efficient retrieval.** Every entity should have a descriptive label and a plain-language summary. Labels follow naming conventions below. Summaries explain the entity's purpose in one sentence — enabling agents to scan without reading all properties.

---

## Entity Types

### PlanningInstrument

A statutory or policy document that establishes planning rules. Represents schemes, local planning policies, structure plans, strategies, and region schemes.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `instrumentType` | string | yes | Type of instrument — see recommended values below |
| `status` | string | yes | `operative`, `draft`, `superseded`, `under-review`, `gazetted` |
| `title` | string | yes | Full official title of the document |
| `referenceNumber` | string | no | Official reference (e.g. "LPS12", "LPP1", "POL-LUP 06") |
| `effectiveDate` | string | no | ISO 8601 date — when the instrument came into effect |
| `gazettalDate` | string | no | ISO 8601 date — when gazetted (for statutory instruments) |
| `reviewDate` | string | no | ISO 8601 date — scheduled review date |
| `jurisdiction` | string | no | Local government area (e.g. "City of Mandurah") |
| `administeredUnder` | string | no | Parent legislation (e.g. "Planning and Development Act 2005") |
| `description` | string | no | Plain-language summary of the instrument's purpose |

**Label convention:** `{title}` or `{referenceNumber}: {short title}` (e.g. "Local Planning Scheme No. 12" or "LPP1: Residential Design Codes").

**Summary convention:** A one-sentence description, e.g. "The operative local planning scheme for the City of Mandurah, establishing zones, reserves, and development control standards."

**Recommended `instrumentType` values:**

| Value | Description |
|-------|-------------|
| `local-planning-scheme` | Statutory scheme controlling land use and development |
| `local-planning-policy` | Non-statutory policy providing guidance on specific matters |
| `structure-plan` | Area-level plan guiding subdivision and development staging |
| `region-scheme` | State/regional level planning framework |
| `strategy` | Long-term planning strategy (e.g. community infrastructure) |
| `activity-centre-plan` | Detailed plan for a centre/precinct |
| `precinct-plan` | Sub-area plan within a structure plan |
| `design-guidelines` | Detailed design standards for a specific area or type |

---

### Zone

A land use classification area established by a planning scheme. Zones define what uses are permitted, conditionally permitted, or prohibited on land within their boundaries.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `zoneType` | string | yes | Zone classification — see recommended values below |
| `objectives` | string | no | Stated objectives of the zone (from scheme text) |
| `maxPlotRatio` | number | no | Maximum plot ratio (floor area to site area) |
| `maxBuildingHeight` | string | no | Maximum building height (e.g. "10m", "3 storeys") |
| `minLotSize` | number | no | Minimum lot size in m² |
| `maxRetailFloorspace` | number | no | Maximum retail floorspace in m² (for centre zones) |
| `densityRange` | string | no | Applicable R-Code range (e.g. "R20–R60") |
| `description` | string | no | Plain-language summary of the zone's purpose |

> **Do NOT add setback, parking, landscaping, floorspace, car parking, or lot-frontage standards as Zone properties.** These are Provision entities linked to the Zone via `APPLIES_IN`. The only properties that may be set directly on a Zone are the ones listed in the table above. If a standard is not in the table, create a Provision for it — do not invent new Zone properties.

**Label convention:** The zone name as it appears in the scheme (e.g. "Residential", "Strategic Centre", "Service Commercial").

**Summary convention:** A one-sentence description, e.g. "Provides for a range of residential dwellings to accommodate varied housing needs."

**Recommended `zoneType` values:**

| Value | Description |
|-------|-------------|
| `strategic-centre` | Primary activity centre — mixed use, high density |
| `district-centre` | Major centre serving surrounding suburbs |
| `neighbourhood-centre` | Local shopping and services for a neighbourhood |
| `local-centre` | Small-scale convenience retail and services |
| `service-commercial` | Showrooms, trade supplies, light industry |
| `general-industry` | Manufacturing, processing, storage |
| `mixed-use` | Combination of residential and commercial |
| `residential` | Primarily housing at varied densities |
| `rural-residential` | Large-lot rural living |
| `rural-smallholdings` | Rural lots for hobby farming or semi-rural use |
| `rural` | Broad-acre farming and primary production |
| `private-community-uses` | Private community, educational, or religious purposes |
| `tourism` | Tourist accommodation and related services |
| `urban-development` | Land identified for future urban development |
| `special-use` | Site-specific use not fitting other zones |

---

### Reserve

Land reserved for a specific public purpose under a planning scheme or region scheme. Reserves are distinct from zones — they protect land for a defined purpose and restrict development accordingly.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `reserveType` | string | yes | Reserve classification — see recommended values below |
| `purpose` | string | no | Stated purpose of the reserve |
| `managedBy` | string | no | Authority responsible for the reserve |
| `description` | string | no | Plain-language summary |

**Label convention:** `{reserveType}: {location or name}` (e.g. "Environmental Conservation: Dawesville Channel Foreshore").

**Recommended `reserveType` values:**

| Value | Description |
|-------|-------------|
| `environmental-conservation` | Biodiversity protection, wetlands, foreshore |
| `public-purposes` | General public use (civic, utility, infrastructure) |
| `regional-open-space` | Parks and recreation at regional scale |
| `parks-and-recreation` | Local parks, playgrounds, sporting grounds |
| `educational` | Schools and educational institutions |
| `medical` | Hospitals and health facilities |
| `civic` | Council offices, libraries, community centres |
| `drainage` | Stormwater management and drainage infrastructure |
| `road` | Road and transport infrastructure reserve |
| `waterway` | Canals, rivers, navigable waterways |

---

### LandUse

A classified land use activity as defined in a planning scheme. Land uses are the activities that may or may not be permitted within each zone.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `useClass` | string | yes | Classification category — see recommended values below |
| `definition` | string | no | The scheme's statutory definition of this use |
| `parking` | string | no | Parking standard (e.g. "1 per 20m² NLA") |
| `description` | string | no | Plain-language summary |

> **Do NOT add floorspace limits (`maxFloorspace`, `minFloorspace`), density codes (`densityCode`), lot-size thresholds (`minLotSize`, `minEffectiveFrontage`), employee or area maximums (`maxArea`, `maxEmployees`, `maxSignArea`), occupancy limits, setbacks, or "other requirements" as LandUse properties.** These operational constraints are Provision entities linked to the LandUse via `RESTRICTS` (use restrictions) or to a DensityCode via `APPLIES_AT_DENSITY` (density-conditional rules). The only properties that may be set directly on a LandUse are the ones listed in the table above.

**Label convention:** The use name exactly as it appears in the scheme (e.g. "Single House", "Shop", "Restaurant/Cafe").

**Summary convention:** The scheme definition or a paraphrase, e.g. "A dwelling standing wholly on its own green title lot."

**Recommended `useClass` values:**

| Value | Description |
|-------|-------------|
| `residential` | Housing — single house, grouped dwelling, multiple dwelling |
| `commercial-retail` | Shops, markets, showrooms |
| `commercial-office` | Offices, consulting rooms |
| `hospitality` | Restaurant, cafe, tavern, hotel, short-stay accommodation |
| `industrial` | General industry, light industry, warehouse, storage |
| `community` | Community purpose, place of worship, civic use |
| `recreation` | Public amusement, recreation — private, club premises |
| `education` | Educational establishment, child care premises |
| `health` | Medical centre, hospital, consulting rooms |
| `rural` | Agriculture — extensive, agriculture — intensive, rural pursuit |
| `transport` | Car park, service station, transport depot |
| `tourism` | Tourist development, holiday accommodation, caravan park |
| `infrastructure` | Telecommunications, utility, essential services |

---

### Provision

A discrete regulatory rule, standard, or requirement within a planning instrument. One section of a scheme or policy may generate multiple provisions — split by the distinct rule each imposes.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `provisionType` | string | yes | Type of provision — see recommended values below |
| `content` | string | yes | The provision text or a faithful plain-language summary |
| `sectionReference` | string | no | Section or clause number in the source instrument |
| `status` | string | no | `active` (default), `superseded`, `amended` |
| `measureValue` | string | no | The measurable standard (e.g. "6.0m", "4.5m", "60m²") |
| `measureUnit` | string | no | Unit of measurement (e.g. "m", "m²", "storeys", "days") |
| `conditionText` | string | no | Plain-language conditions under which the provision applies |
| `exemptionText` | string | no | Conditions under which the provision does not apply |
| `approvalRequired` | boolean | no | Whether development approval is required |
| `description` | string | no | Plain-language summary |

> **Do NOT add `parking`, `primaryStreetSetback`, `rearSetback`, `sideSetback`, `densityRange`, `minLotSize`, `minFrontage`, or any other named-standard property to a Provision.** Every Provision carries one measurable standard — encode the numeric value in `measureValue` and the unit in `measureUnit`, with the full rule text in `content`. If you need to express multiple standards (e.g. primary AND rear setbacks), create multiple Provisions. Density applicability is a relationship (`APPLIES_AT_DENSITY` → DensityCode), not a property.

**Label convention:** `{provisionType}: {short description}` (e.g. "Setback: Primary street setback for R20", "Height limit: Maximum wall height in Residential zone").

**Summary convention:** A plain-language one-liner, e.g. "Minimum 6.0m primary street setback for single houses in the R20 density code."

**Recommended `provisionType` values:**

| Value | Description |
|-------|-------------|
| `setback` | Distance requirement from a boundary, road, or waterway |
| `height-limit` | Maximum building or wall height |
| `plot-ratio` | Maximum floor area to site area ratio |
| `site-coverage` | Maximum percentage of lot covered by buildings |
| `density` | Residential density (R-Code) applicable to an area |
| `lot-size` | Minimum or maximum lot dimensions |
| `parking` | Vehicle parking and bicycle parking requirements |
| `landscaping` | Vegetation, open space, or screening requirements |
| `signage-control` | Rules governing sign placement, size, or illumination |
| `waterway-control` | Rules governing structures in or adjacent to waterways |
| `heritage-control` | Special requirements for heritage places or precincts |
| `flood-control` | Requirements for development in flood-prone areas |
| `visual-privacy` | Screening and overlooking requirements |
| `permissibility` | Whether a use is permitted, discretionary, or prohibited |
| `exemption` | Conditions under which approval is not required |
| `infrastructure-contribution` | Developer contributions for community infrastructure |
| `access-and-egress` | Vehicle crossover, driveway, and access requirements |
| `fencing` | Front, side, and rear fence height and material requirements |
| `outbuilding-limit` | Maximum size and number of outbuildings |
| `open-space` | Minimum open space or communal area requirements |

---

### DensityCode

A residential density classification under the Residential Design Codes (R-Codes). Density codes control lot sizes, setbacks, building heights, and other development standards for residential land.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `code` | string | yes | The R-Code designation (e.g. "R20", "R30", "R60") |
| `minLotSize` | number | no | Minimum lot area in m² |
| `avgLotSize` | number | no | Average lot size in m² (where applicable) |
| `maxSiteCoverage` | number | no | Maximum site coverage as percentage |
| `minOpenSpace` | number | no | Minimum open space as percentage |
| `maxBuildingHeight` | string | no | Maximum building height |
| `maxWallHeight` | string | no | Maximum wall height |
| `primaryStreetSetback` | string | no | Minimum setback from primary street in metres |
| `secondaryStreetSetback` | string | no | Minimum setback from secondary street in metres |
| `sideSetback` | string | no | Minimum side boundary setback in metres |
| `rearSetback` | string | no | Minimum rear boundary setback in metres |
| `minLotFrontage` | string | no | Minimum lot frontage in metres |
| `dwellingTypes` | string | no | Permitted dwelling types (e.g. "single, grouped") |
| `description` | string | no | Plain-language summary |

**Label convention:** The R-Code designation (e.g. "R20", "R2.5", "R80").

**Summary convention:** A brief description, e.g. "Standard suburban residential density — minimum 450m² lots, single and grouped dwellings."

**Recommended `code` values:**

| Value | Typical min lot size | Typical use |
|-------|---------------------|-------------|
| `R2` | 5000m² | Rural-residential |
| `R2.5` | 4000m² | Rural-residential |
| `R5` | 2000m² | Large-lot residential |
| `R10` | 1000m² | Low-density suburban |
| `R12.5` | 800m² | Low-density suburban |
| `R15` | 666m² | Low-density suburban |
| `R17.5` | 570m² | Suburban |
| `R20` | 450m² | Standard suburban |
| `R25` | 350m² | Medium-density suburban |
| `R30` | 300m² | Medium-density |
| `R35` | 260m² | Medium-density |
| `R40` | 220m² | Medium–high density |
| `R50` | 180m² | Medium–high density |
| `R60` | 150m² | High-density |
| `R80` | 120m² | High-density apartment |
| `R100` | 100m² | Very high-density apartment |
| `R160` | 60m² | Very high-density apartment |
| `R-AC` | varies | Activity Centre — apartments/mixed use, lot size per the activity centre plan |

---

### StructureType

A classification of built structure subject to specific planning controls. This covers dwellings, outbuildings, signs, waterway structures, and any other physical element regulated by planning provisions.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `structureCategory` | string | yes | Broad category — see recommended values below |
| `structureSubtype` | string | no | Specific subtype within the category |
| `maxHeight` | string | no | Maximum permitted height |
| `maxArea` | string | no | Maximum permitted area (e.g. "60m²") |
| `maxWidth` | string | no | Maximum permitted width |
| `maxLength` | string | no | Maximum permitted length |
| `setbackRequired` | string | no | Required setback distance |
| `approvalRequired` | boolean | no | Whether development approval is needed |
| `exemptConditions` | string | no | Conditions for approval exemption |
| `materials` | string | no | Material requirements or restrictions |
| `configuration` | string | no | Permitted configurations (e.g. "finger, T-shaped, L-shaped") |
| `description` | string | no | Plain-language summary |

> **`definition` is NOT a StructureType property — it belongs on LandUse only.** Use `description` on StructureType for a plain-language summary. Do not add `conditionText`, `minSetback`, `maxWallHeight`, `maxVolume`, `maxDiameter`, `maxQuantity`, or any other dimensional property not listed in the table above. Dimensional standards and operational restrictions that are not already covered by the fields above must be Provision entities linked via `REGULATES`. The vocab-defined StructureType properties (`maxHeight`, `maxArea`, `maxWidth`, `maxLength`, `setbackRequired`) cover the broad, type-wide limits; anything zone-, density-, or precinct-conditional goes on a Provision.

**Label convention:** The structure name as used in the planning instrument (e.g. "Single House", "Pylon Sign", "Finger Jetty", "Mechanical Boat Lift").

**Summary convention:** A one-sentence description, e.g. "A freestanding sign mounted on one or two poles, maximum 6m height and 2.5m width, requiring development approval."

**Recommended `structureCategory` values:**

| Value | Description |
|-------|-------------|
| `dwelling` | Residential buildings — single house, grouped dwelling, multiple dwelling, ancillary dwelling |
| `outbuilding` | Shed, workshop, garage, studio — detached from dwelling |
| `patio-pergola` | Open-sided roofed structure or lattice structure |
| `retaining-wall` | Wall retaining earth/managing grade changes |
| `deck` | Elevated platform structure |
| `fence` | Front, side, or rear boundary fence |
| `swimming-pool` | Pool and associated safety barriers |
| `sign-exempt` | Signage not requiring development approval |
| `sign-approval-required` | Signage requiring development approval |
| `jetty` | Jetty structure in waterway (finger, T-shaped, L-shaped, land-backed) |
| `boat-lifting-structure` | Mechanical (hydraulic lift) or floating (sea pen) boat lifter |
| `mooring-pole` | Simple pole for securing a vessel |
| `davit` | Canal wall-mounted mechanical lifting device |
| `carport` | Open-sided vehicle shelter |
| `undercroft-storeroom` | Below-building storage space |

**Recommended `structureSubtype` values for signs:**

| Value | Description |
|-------|-------------|
| `awning-sign` | Attached to awning or canopy fascia |
| `wall-sign` | Mounted flat against building wall |
| `window-sign` | Applied to or behind glass surface |
| `portable-sign` | Freestanding moveable sign (A-frame, sandwich board) |
| `projecting-sign` | Projects from building wall at right angles |
| `under-verandah-sign` | Suspended below verandah or awning |
| `roof-sign` | Mounted on or above the roof line |
| `pylon-sign` | Freestanding on pole(s), detached from building |
| `inflatable-sign` | Inflatable advertising device |
| `third-party-sign` | Advertising unrelated to premises use |
| `construction-sign` | Temporary sign during building works |
| `property-sale-sign` | Real estate for sale or lease sign |

**Recommended `structureSubtype` values for jetties:**

| Value | Description |
|-------|-------------|
| `finger-jetty` | Single walkway extending from canal wall |
| `t-shaped-jetty` | T-configuration — main walkway with perpendicular head |
| `l-shaped-jetty` | L-configuration — main walkway with right-angle extension |
| `land-backed-jetty` | Jetty built against or extending from canal wall |

---

### CommunityFacility

A type of social infrastructure facility required to serve a population. Represents facility categories used in community infrastructure planning, not individual buildings.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `facilityType` | string | yes | Type of facility — see recommended values below |
| `landSize` | string | no | Recommended land area (e.g. "0.2–0.3ha") |
| `coLocationSuitable` | boolean | no | Whether this facility can be co-located with others |
| `description` | string | no | Plain-language summary |

**Label convention:** The facility type name (e.g. "Branch Library", "District Community Centre", "Local Playground").

**Recommended `facilityType` values:**

| Value | Description |
|-------|-------------|
| `community-centre` | General-purpose community meeting and activity space |
| `library` | Public lending library (branch or district) |
| `sports-ground` | Playing fields, ovals, courts |
| `aquatic-centre` | Swimming pool, aquatic recreation |
| `playground` | Children's play equipment area |
| `youth-facility` | Youth centre, skate park, dedicated youth space |
| `senior-facility` | Senior citizens centre, aged care day centre |
| `childcare-centre` | Long day care, occasional care, family day care |
| `cultural-facility` | Performing arts, gallery, museum, cultural centre |
| `civic-facility` | Council offices, civic administration |
| `health-facility` | Community health centre, allied health |
| `emergency-services` | Fire station, ambulance, SES facility |
| `multipurpose-hub` | Co-located facility combining multiple community uses |

---

### HierarchyLevel

A population-based tier in a community infrastructure planning hierarchy. Defines the population catchment and typical facility mix for each service level.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `levelName` | string | yes | Tier name — see recommended values below |
| `populationMin` | number | yes | Minimum population catchment |
| `populationMax` | number | yes | Maximum population catchment |
| `typicalLandSize` | string | no | Recommended land area for community facilities hub |
| `description` | string | no | Plain-language summary |

**Label convention:** `{levelName}` (e.g. "Local", "Neighbourhood", "District").

**Summary convention:** Population range and role, e.g. "Serves 7,500–15,000 people with shared community facilities in a neighbourhood hub."

**Recommended `levelName` values:**

| Value | Population range | Typical facility hub size |
|-------|-----------------|--------------------------|
| `local` | 0–7,500 | 0.2–0.3ha |
| `neighbourhood` | 7,500–15,000 | 0.3–0.5ha |
| `district` | 15,000–35,000 | 0.5–1.0ha |
| `city-wide` | 35,000–70,000 | 1.0–1.5ha |
| `sub-regional` | 70,000–140,000 | 1.5ha+ |

---

### Precinct

A named geographic area with special planning provisions that override or supplement zone-wide standards. Precincts represent heritage areas, canal estates, marina areas, special character areas, and other location-specific planning contexts.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `precinctType` | string | yes | Type of precinct — see recommended values below |
| `location` | string | no | General location description |
| `specialProvisions` | string | no | Summary of what makes this precinct different from zone-wide standards |
| `description` | string | no | Plain-language summary |

> **Use `description` for a plain-language summary — not `definition`.** `definition` is a LandUse property and does not exist on Precinct. Do not invent new Precinct properties for specific standards; create Provision entities linked via `APPLIES_IN_PRECINCT` instead.

**Label convention:** The precinct or area name as used in the planning instrument (e.g. "Port Mandurah Stage 1", "Mandurah Ocean Marina", "Apollo Place Heritage Area").

**Recommended `precinctType` values:**

| Value | Description |
|-------|-------------|
| `canal-estate` | Residential estate with canal waterways |
| `marina` | Boat mooring and marine services precinct |
| `heritage-area` | Area with heritage character or heritage-listed places |
| `special-character` | Area with specific design or character requirements |
| `flood-hazard` | Area subject to flood risk controls |
| `foreshore` | Land adjacent to ocean, river, or estuary foreshore |
| `activity-centre` | Town centre, neighbourhood centre, or commercial core |
| `development-area` | Area subject to a structure plan or staged development |
| `distributor-road` | Properties fronting a primary or district distributor road |

---

## Relationship Types

### Planning Instrument Relationships

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `CONTAINS_PROVISION` | This instrument establishes this provision | PlanningInstrument → Provision | no |
| `REFERENCES_INSTRUMENT` | This instrument references another instrument | PlanningInstrument → PlanningInstrument | no |
| `SUPERSEDES` | This instrument replaces a prior instrument | PlanningInstrument → PlanningInstrument | no |
| `SUBORDINATE_TO` | This instrument operates under a parent instrument | PlanningInstrument → PlanningInstrument | no |

#### Properties for `SUPERSEDES`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `effectiveDate` | string | no | ISO 8601 date — when the supersession took effect |
| `reason` | string | no | Why the prior instrument was replaced |

#### Properties for `SUBORDINATE_TO`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `relationship` | string | no | Nature of subordination (e.g. "adopted under", "must be consistent with") |

---

### Zone and Land Use Relationships

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `PERMITS` | This zone allows this land use at a given permissibility level | Zone → LandUse | no |
| `APPLIES_IN` | This provision applies within this zone | Provision → Zone | no |
| `CLASSIFIED_UNDER` | This density code is applicable within this zone | DensityCode → Zone | no |

#### Properties for `PERMITS`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `permissibility` | string | yes | `P` (permitted), `D` (discretionary), `A` (not-permitted-unless-advertised), `X` (not-permitted) |
| `conditions` | string | no | Special conditions on the permissibility |
| `maxFloorspace` | string | no | Maximum floorspace limit if applicable |

#### Properties for `APPLIES_IN`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `scope` | string | no | Any limitation on how the provision applies in this zone |

---

### Provision Relationships

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `APPLIES_AT_DENSITY` | This provision applies at this density code | Provision → DensityCode | no |
| `APPLIES_IN_PRECINCT` | This provision applies within this precinct | Provision → Precinct | no |
| `REGULATES` | This provision regulates this structure type | Provision → StructureType | no |
| `OVERRIDES` | This provision overrides or takes precedence over another provision | Provision → Provision | no |
| `REFERENCES_PROVISION` | This provision cross-references another provision | Provision → Provision | no |

#### Properties for `REGULATES`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `aspect` | string | no | What aspect is regulated (e.g. "setback", "height", "area", "placement", "materials") |
| `measureValue` | string | no | The regulated value (e.g. "6.0m", "60m²") |
| `conditions` | string | no | Conditions on the regulation |

#### Properties for `OVERRIDES`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `reason` | string | no | Why this provision takes precedence |
| `scope` | string | no | Circumstances under which the override applies |

---

### Precinct Relationships

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `LOCATED_IN` | This precinct is within this zone | Precinct → Zone | no |
| `WITHIN_RESERVE` | This precinct overlaps with or is adjacent to this reserve | Precinct → Reserve | no |

---

### Community Infrastructure Relationships

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `REQUIRES_FACILITY` | This hierarchy level requires this type of community facility | HierarchyLevel → CommunityFacility | no |
| `SERVES` | This community facility serves this hierarchy level | CommunityFacility → HierarchyLevel | no |

#### Properties for `REQUIRES_FACILITY`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `quantity` | string | no | How many facilities of this type are expected |
| `landSize` | string | no | Recommended land allocation |
| `coLocate` | boolean | no | Whether this facility should be co-located with others |
| `priority` | string | no | `essential`, `desirable`, `aspirational` |

---

### Cross-Reference Relationships

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `EXEMPTS` | This provision grants an exemption for this structure type | Provision → StructureType | no |
| `RESTRICTS` | This provision restricts this land use | Provision → LandUse | no |

#### Properties for `EXEMPTS`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `conditions` | string | no | Conditions under which the exemption applies |
| `limitations` | string | no | Limitations on the exemption (e.g. maximum dimensions) |

#### Properties for `RESTRICTS`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `restrictionType` | string | no | Nature of restriction (e.g. "prohibited", "limited-floorspace", "conditional") |
| `conditions` | string | no | Conditions on the restriction |

---

## Design Notes

- **Planning instruments are shared across provisions.** One scheme creates hundreds of provisions — reuse the instrument entity and link all provisions to it via `CONTAINS_PROVISION`.
- **Zones are shared across provisions.** Multiple provisions apply in the same zone. Reuse zone entities rather than creating duplicates.
- **Land uses are shared across zones.** The same land use (e.g. "Shop") may be permitted in one zone and prohibited in another. Create one `LandUse` entity and link it to multiple zones via `PERMITS` with different `permissibility` values.
- **Provisions should be atomic.** If a scheme section establishes both a setback and a height limit, create two `Provision` entities. This enables precise queries like "what setbacks apply in zone X?" without parsing multi-rule provisions.
- **OVERRIDES captures the planning hierarchy.** Where a local planning policy provision modifies a scheme standard, link them via `OVERRIDES`. This makes the effective rule discoverable by graph traversal.
- **Precincts may overlap zones.** A heritage precinct can span multiple zones. Use `LOCATED_IN` to record the primary zone, and `APPLIES_IN_PRECINCT` on provisions to capture precinct-specific rules.
- **Structure types are reused across provisions.** A "Pylon Sign" entity may be regulated by provisions from both the signage policy and the scheme. Link it to all relevant provisions via `REGULATES`.
- **Permissibility codes follow the standard scheme convention.** `P` = permitted as of right, `D` = discretionary (council assessment required), `A` = not permitted unless advertised and approved, `X` = not permitted. These are the standard WA planning system codes.
- **Relationship types are normalized** to `SCREAMING_SNAKE_CASE` by the core library.
- **This vocabulary is extensible.** In `open` governance mode, common extensions include `ADJACENT_TO` (spatial adjacency between precincts), `TRIGGERED_BY` (provision triggered by a development event), and `COMPATIBLE_WITH` (land uses that are complementary).
