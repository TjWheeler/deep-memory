import { describe, it, expect } from 'vitest';
import { parseVocabularyMarkdown, augmentVocabularyFromData, extractControlledValuesByEntityType } from './VocabularyMarkdownParser.js';
import type { StoredEntity, StoredRelationship, Provenance } from '@utaba/deep-memory';

const prov: Provenance = {
  createdBy: 'test',
  createdByType: 'agent',
  createdAt: '2026-04-10T00:00:00Z',
  modifiedBy: 'test',
  modifiedByType: 'agent',
  modifiedAt: '2026-04-10T00:00:00Z',
};

describe('parseVocabularyMarkdown', () => {
  it('parses entity types with properties', () => {
    const md = `# Vocabulary

## Entity Types

### Equipment

A piece of mining equipment used in fleet operations.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`equipmentType\` | string | yes | Type of equipment |
| \`weight\` | number | no | Operating weight in tonnes |
| \`operational\` | boolean | no | Whether currently in service |

**Label convention:** Use the model name.

### Fluid

A fluid used in equipment maintenance.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`fluidType\` | string | yes | Classification of fluid |
| \`viscosity\` | string | no | Viscosity rating |

## Relationship Types
`;

    const vocab = parseVocabularyMarkdown(md);

    expect(vocab.entityTypes).toHaveLength(2);

    const equipment = vocab.entityTypes.find(t => t.type === 'Equipment')!;
    expect(equipment).toBeDefined();
    expect(equipment.description).toContain('mining equipment');
    expect(equipment.properties).toHaveLength(3);
    expect(equipment.properties[0]).toEqual(expect.objectContaining({
      name: 'equipmentType',
      type: 'string',
      required: true,
    }));
    expect(equipment.properties[1]).toEqual(expect.objectContaining({
      name: 'weight',
      type: 'number',
      required: false,
    }));
    expect(equipment.properties[2]).toEqual(expect.objectContaining({
      name: 'operational',
      type: 'boolean',
      required: false,
    }));

    const fluid = vocab.entityTypes.find(t => t.type === 'Fluid')!;
    expect(fluid).toBeDefined();
    expect(fluid.properties).toHaveLength(2);
  });

  it('parses relationship types with source/target and bidirectional flag', () => {
    const md = `# Vocabulary

## Entity Types

## Relationship Types

### Equipment Relationships

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| \`COMPATIBLE_WITH\` | These equipment types work together | Equipment → Equipment | yes |
| \`USES_FLUID\` | This equipment uses this fluid | Equipment → Fluid | no |

### Maintenance Relationships

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| \`PERFORMED_ON\` | Maintenance task performed on equipment | Task → Equipment | no |
`;

    const vocab = parseVocabularyMarkdown(md);

    expect(vocab.relationshipTypes).toHaveLength(3);

    const compat = vocab.relationshipTypes.find(t => t.type === 'COMPATIBLE_WITH')!;
    expect(compat).toBeDefined();
    expect(compat.description).toContain('work together');
    expect(compat.allowedSourceTypes).toEqual(['Equipment']);
    expect(compat.allowedTargetTypes).toEqual(['Equipment']);
    expect(compat.bidirectional).toBe(true);

    const usesFluid = vocab.relationshipTypes.find(t => t.type === 'USES_FLUID')!;
    expect(usesFluid).toBeDefined();
    expect(usesFluid.allowedSourceTypes).toEqual(['Equipment']);
    expect(usesFluid.allowedTargetTypes).toEqual(['Fluid']);
    expect(usesFluid.bidirectional).toBe(false);
  });

  it('parses relationship properties from subsections', () => {
    const md = `# Vocabulary

## Entity Types

## Relationship Types

### Instrument Relationships

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| \`SUPERSEDES\` | This instrument replaces another | Instrument → Instrument | no |

#### Properties for \`SUPERSEDES\`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`effectiveDate\` | string | no | When the supersession took effect |
| \`reason\` | string | no | Why the prior instrument was replaced |
`;

    const vocab = parseVocabularyMarkdown(md);

    const supersedes = vocab.relationshipTypes.find(t => t.type === 'SUPERSEDES')!;
    expect(supersedes).toBeDefined();
    expect(supersedes.properties).toHaveLength(2);
    expect(supersedes.properties![0]).toEqual(expect.objectContaining({
      name: 'effectiveDate',
      type: 'string',
      required: false,
    }));
  });

  it('populates enumValues for a closed-enum relationship property from its Allowed values table', () => {
    const md = `# Council Planning Domain — Vocabulary

## Entity Types

## Relationship Types

### Zone and Land Use Relationships

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| \`PERMITS\` | This zone allows this land use | Zone → LandUse | no |

#### Properties for \`PERMITS\`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`permissibility\` | enum | yes | Whether a use is permitted, discretionary, or prohibited |
| \`conditions\` | string | no | Special conditions |

**Allowed \`permissibility\` values:**

| Value | Description |
|-------|-------------|
| \`P\` | Permitted |
| \`D\` | Discretionary |
| \`A\` | Not permitted unless advertised |
| \`X\` | Not permitted |
`;

    const vocab = parseVocabularyMarkdown(md);
    const permits = vocab.relationshipTypes.find(t => t.type === 'PERMITS')!;
    const permissibility = permits.properties!.find(p => p.name === 'permissibility')!;

    expect(permissibility.type).toBe('enum');
    expect(permissibility.enumValues).toEqual(['P', 'D', 'A', 'X']);

    // A sibling open property carries no enum set.
    const conditions = permits.properties!.find(p => p.name === 'conditions')!;
    expect(conditions.type).toBe('string');
    expect(conditions.enumValues).toBeUndefined();
  });

  it('leaves a Recommended-values property open (string, no enumValues)', () => {
    const md = `# Vocabulary

## Entity Types

### CommunityFacility

A social infrastructure facility.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`facilityType\` | string | yes | Type of facility — see recommended values below |
| \`landSize\` | string | no | Recommended land area |

**Recommended \`facilityType\` values:**

| Value | Description |
|-------|-------------|
| \`library\` | Public lending library |
| \`playground\` | Children's play equipment area |

## Relationship Types
`;

    const vocab = parseVocabularyMarkdown(md);
    const facility = vocab.entityTypes.find(t => t.type === 'CommunityFacility')!;
    const facilityType = facility.properties.find(p => p.name === 'facilityType')!;

    expect(facilityType.type).toBe('string');
    expect(facilityType.enumValues).toBeUndefined();
  });

  it('populates enumValues for a closed-enum entity property from its Allowed values table', () => {
    const md = `# Vocabulary

## Entity Types

### Application

A development application.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`decision\` | enum | yes | The outcome of the application |

**Allowed \`decision\` values:**

| Value | Description |
|-------|-------------|
| \`approved\` | Approved |
| \`refused\` | Refused |
| \`withdrawn\` | Withdrawn |

## Relationship Types
`;

    const vocab = parseVocabularyMarkdown(md);
    const application = vocab.entityTypes.find(t => t.type === 'Application')!;
    const decision = application.properties.find(p => p.name === 'decision')!;

    expect(decision.type).toBe('enum');
    expect(decision.enumValues).toEqual(['approved', 'refused', 'withdrawn']);
  });

  it('leaves enumValues undefined for an enum property with no Allowed table', () => {
    // A missing Allowed table must yield undefined, never an empty array: an
    // empty enumValues array would make the core validator reject every value.
    const md = `# Vocabulary

## Entity Types

### Application

A development application.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`decision\` | enum | yes | The outcome |

## Relationship Types
`;

    const vocab = parseVocabularyMarkdown(md);
    const decision = vocab.entityTypes.find(t => t.type === 'Application')!.properties.find(p => p.name === 'decision')!;

    expect(decision.type).toBe('enum');
    expect(decision.enumValues).toBeUndefined();
  });

  it('leaves enumValues undefined for an enum property that only has a Recommended table', () => {
    const md = `# Vocabulary

## Entity Types

### Application

A development application.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`decision\` | enum | yes | The outcome |

**Recommended \`decision\` values:**

| Value | Description |
|-------|-------------|
| \`approved\` | Approved |
| \`refused\` | Refused |

## Relationship Types
`;

    const vocab = parseVocabularyMarkdown(md);
    const decision = vocab.entityTypes.find(t => t.type === 'Application')!.properties.find(p => p.name === 'decision')!;

    expect(decision.type).toBe('enum');
    expect(decision.enumValues).toBeUndefined();
  });

  it('binds each enum property to its own Allowed table within one section', () => {
    const md = `# Vocabulary

## Entity Types

### Application

A development application.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`decision\` | enum | yes | The outcome |
| \`stage\` | enum | yes | The processing stage |

**Allowed \`decision\` values:**

| Value | Description |
|-------|-------------|
| \`approved\` | Approved |
| \`refused\` | Refused |

**Allowed \`stage\` values:**

| Value | Description |
|-------|-------------|
| \`lodged\` | Lodged |
| \`assessment\` | Under assessment |
| \`determined\` | Determined |

## Relationship Types
`;

    const vocab = parseVocabularyMarkdown(md);
    const application = vocab.entityTypes.find(t => t.type === 'Application')!;
    const decision = application.properties.find(p => p.name === 'decision')!;
    const stage = application.properties.find(p => p.name === 'stage')!;

    expect(decision.enumValues).toEqual(['approved', 'refused']);
    expect(stage.enumValues).toEqual(['lodged', 'assessment', 'determined']);
  });

  it('returns empty vocabulary when no sections found', () => {
    const md = `# Just a title

Some text with no entity or relationship sections.
`;

    const vocab = parseVocabularyMarkdown(md);

    expect(vocab.entityTypes).toHaveLength(0);
    expect(vocab.relationshipTypes).toHaveLength(0);
    expect(vocab.version).toBe('1.0.0');
  });

  it('parses the council vocabulary.md format correctly', () => {
    // Minimal excerpt from the real council starter kit
    const md = `# Council Planning Domain — Vocabulary

---

## Entity Types

### PlanningInstrument

A statutory or policy document that establishes planning rules.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`instrumentType\` | string | yes | Type of instrument |
| \`status\` | string | yes | Status of the instrument |
| \`title\` | string | yes | Full official title |

---

### Zone

A land use classification area established by a planning scheme.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`zoneType\` | string | yes | Zone classification |
| \`maxPlotRatio\` | number | no | Maximum plot ratio |

---

## Relationship Types

### Planning Instrument Relationships

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| \`CONTAINS_PROVISION\` | This instrument establishes this provision | PlanningInstrument → Provision | no |
| \`SUPERSEDES\` | This instrument replaces a prior instrument | PlanningInstrument → PlanningInstrument | no |

#### Properties for \`SUPERSEDES\`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`effectiveDate\` | string | no | When supersession took effect |

### Zone and Land Use Relationships

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| \`PERMITS\` | This zone allows this land use | Zone → LandUse | no |
| \`APPLIES_IN\` | This provision applies within this zone | Provision → Zone | no |

#### Properties for \`PERMITS\`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`permissibility\` | string | yes | P, D, A, or X |

## Design Notes

These notes should not be parsed as types.
`;

    const vocab = parseVocabularyMarkdown(md);

    // Entity types
    expect(vocab.entityTypes).toHaveLength(2);
    expect(vocab.entityTypes.map(t => t.type)).toEqual(['PlanningInstrument', 'Zone']);

    const pi = vocab.entityTypes.find(t => t.type === 'PlanningInstrument')!;
    expect(pi.properties).toHaveLength(3);
    expect(pi.properties.find(p => p.name === 'instrumentType')?.required).toBe(true);

    const zone = vocab.entityTypes.find(t => t.type === 'Zone')!;
    expect(zone.properties).toHaveLength(2);
    expect(zone.properties.find(p => p.name === 'maxPlotRatio')?.type).toBe('number');

    // Relationship types
    expect(vocab.relationshipTypes).toHaveLength(4);
    expect(vocab.relationshipTypes.map(t => t.type)).toEqual([
      'CONTAINS_PROVISION', 'SUPERSEDES', 'PERMITS', 'APPLIES_IN',
    ]);

    const supersedes = vocab.relationshipTypes.find(t => t.type === 'SUPERSEDES')!;
    expect(supersedes.properties).toHaveLength(1);
    expect(supersedes.properties![0]!.name).toBe('effectiveDate');

    const permits = vocab.relationshipTypes.find(t => t.type === 'PERMITS')!;
    expect(permits.allowedSourceTypes).toEqual(['Zone']);
    expect(permits.allowedTargetTypes).toEqual(['LandUse']);
    expect(permits.properties).toHaveLength(1);
    expect(permits.properties![0]!.required).toBe(true);
  });
});

describe('augmentVocabularyFromData', () => {
  it('adds entity types from data not in vocabulary', () => {
    const vocab = parseVocabularyMarkdown(`
## Entity Types

### Equipment

A piece of equipment.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`equipmentType\` | string | yes | Type |
`);

    const entities: StoredEntity[] = [
      { id: '1', slug: 'equipment:truck', entityType: 'Equipment', label: 'Truck', properties: {}, provenance: prov },
      { id: '2', slug: 'fluid:oil', entityType: 'Fluid', label: 'Engine Oil', properties: { viscosity: '15W-40', temperature: 90 }, provenance: prov },
      { id: '3', slug: 'fluid:coolant', entityType: 'Fluid', label: 'Coolant', properties: { viscosity: '50/50' }, provenance: prov },
    ];

    const result = augmentVocabularyFromData(vocab, entities, []);

    expect(result.entityTypes).toHaveLength(2);
    expect(result.entityTypes.find(t => t.type === 'Equipment')).toBeDefined();

    const fluid = result.entityTypes.find(t => t.type === 'Fluid')!;
    expect(fluid).toBeDefined();
    expect(fluid.description).toContain('Inferred');
    expect(fluid.properties.find(p => p.name === 'viscosity')?.type).toBe('string');
    expect(fluid.properties.find(p => p.name === 'temperature')?.type).toBe('number');
  });

  it('adds relationship types from data not in vocabulary', () => {
    const vocab = parseVocabularyMarkdown('');

    const entities: StoredEntity[] = [
      { id: 'e1', slug: 'equipment:truck', entityType: 'Equipment', label: 'Truck', properties: {}, provenance: prov },
      { id: 'e2', slug: 'fluid:oil', entityType: 'Fluid', label: 'Oil', properties: {}, provenance: prov },
    ];

    const relationships: StoredRelationship[] = [
      {
        id: 'r1', relationshipType: 'USES_FLUID',
        sourceEntityId: 'e1', targetEntityId: 'e2',
        properties: { quantity: '10L' }, bidirectional: false, provenance: prov,
      },
    ];

    const result = augmentVocabularyFromData(vocab, entities, relationships);

    expect(result.relationshipTypes).toHaveLength(1);
    const rel = result.relationshipTypes[0]!;
    expect(rel.type).toBe('USES_FLUID');
    expect(rel.allowedSourceTypes).toEqual(['Equipment']);
    expect(rel.allowedTargetTypes).toEqual(['Fluid']);
    expect(rel.properties).toHaveLength(1);
    expect(rel.properties![0]!.name).toBe('quantity');
  });

  it('does not duplicate types already in vocabulary', () => {
    const vocab = parseVocabularyMarkdown(`
## Entity Types

### Equipment

A piece of equipment.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`equipmentType\` | string | yes | Type |

## Relationship Types

### Equipment Relationships

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| \`COMPATIBLE_WITH\` | Works together | Equipment → Equipment | yes |
`);

    const entities: StoredEntity[] = [
      { id: '1', slug: 'equipment:truck', entityType: 'Equipment', label: 'Truck', properties: { equipmentType: 'haul-truck' }, provenance: prov },
    ];

    const relationships: StoredRelationship[] = [
      {
        id: 'r1', relationshipType: 'COMPATIBLE_WITH',
        sourceEntityId: '1', targetEntityId: '1',
        properties: {}, bidirectional: true, provenance: prov,
      },
    ];

    const result = augmentVocabularyFromData(vocab, entities, relationships);

    expect(result.entityTypes).toHaveLength(1);
    expect(result.relationshipTypes).toHaveLength(1);
  });

  it('returns unchanged vocabulary when no new types found', () => {
    const vocab = parseVocabularyMarkdown(`
## Entity Types

### Equipment

Some equipment.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`name\` | string | yes | Name |
`);

    const entities: StoredEntity[] = [
      { id: '1', slug: 'equipment:truck', entityType: 'Equipment', label: 'Truck', properties: {}, provenance: prov },
    ];

    const result = augmentVocabularyFromData(vocab, entities, []);

    // Should be the exact same object reference
    expect(result).toBe(vocab);
  });
});

describe('extractControlledValuesByEntityType', () => {
  it('captures both open recommended and closed allowed value grids per type', () => {
    const md = `# Vocabulary

## Entity Types

### Facility

A community facility.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`facilityType\` | string | yes | See recommended values |

**Recommended \`facilityType\` values:**

| Value | Description |
|-------|-------------|
| \`library\` | A library |
| \`pool\` | A swimming pool |
| \`hall\` | A community hall |

### Provision

A rule.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`permissibility\` | enum | yes | Allowed set |

**Allowed \`permissibility\` values:**

| Value | Description |
|-------|-------------|
| \`P\` | Permitted |
| \`D\` | Discretionary |

## Relationship Types
`;

    const result = extractControlledValuesByEntityType(md);
    expect(result['Facility']).toEqual(['library', 'pool', 'hall']);
    expect(result['Provision']).toEqual(['P', 'D']);
  });

  it('merges qualified recommended grids for the same type', () => {
    const md = `## Entity Types

### Structure

A structure.

**Recommended \`structureSubtype\` values for signs:**

| Value | Description |
|-------|-------------|
| \`billboard\` | A billboard |

**Recommended \`structureSubtype\` values for jetties:**

| Value | Description |
|-------|-------------|
| \`pontoon\` | A pontoon |
`;
    const result = extractControlledValuesByEntityType(md);
    expect(result['Structure']).toEqual(['billboard', 'pontoon']);
  });

  it('returns an empty map when there are no controlled-value grids', () => {
    const md = `## Entity Types

### Person

A person.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`name\` | string | yes | Full name |
`;
    expect(extractControlledValuesByEntityType(md)).toEqual({});
  });
});
