import { describe, it, expect } from 'vitest';
import type {
  MemoryVocabulary,
  EntityTypeDefinition,
  RelationshipTypeDefinition,
  PropertySchema,
} from '@utaba/deep-memory';
import { VocabularyConformanceGate } from './VocabularyConformanceGate.js';
import type { ExtractionOutput, ExtractedEntity, ExtractedRelationship } from '../types/extraction.js';

const NOW = '2026-07-18T00:00:00Z';

function entityType(type: string, properties: PropertySchema[] = []): EntityTypeDefinition {
  return {
    type,
    description: `${type} test type`,
    version: '1.0.0',
    properties,
    createdAt: NOW,
    createdBy: 'test',
    modifiedAt: NOW,
    modifiedBy: 'test',
  };
}

function relationshipType(
  type: string,
  allowedSourceTypes: string[],
  allowedTargetTypes: string[],
  properties: PropertySchema[] = [],
): RelationshipTypeDefinition {
  return {
    type,
    description: `${type} test type`,
    version: '1.0.0',
    allowedSourceTypes,
    allowedTargetTypes,
    bidirectional: false,
    properties,
    createdAt: NOW,
    createdBy: 'test',
    modifiedAt: NOW,
    modifiedBy: 'test',
  };
}

/** A vocabulary with a closed permissibility enum and a Zone → LandUse PERMITS edge. */
function buildVocabulary(): MemoryVocabulary {
  return {
    version: '1.0.0',
    lastModified: NOW,
    modifiedBy: 'test',
    entityTypes: [entityType('Zone'), entityType('LandUse'), entityType('Provision')],
    relationshipTypes: [
      relationshipType('PERMITS', ['Zone'], ['LandUse'], [
        {
          name: 'permissibility',
          type: 'enum',
          required: true,
          enumValues: ['P', 'D', 'A', 'X'],
        },
      ]),
    ],
  };
}

function entity(entityType: string, label: string): ExtractedEntity {
  return { entityType, label, properties: {}, aliases: [], sourceRefs: [] };
}

function relationship(
  type: string,
  sourceLabel: string,
  targetLabel: string,
  properties: Record<string, unknown>,
): ExtractedRelationship {
  return { type, sourceLabel, targetLabel, properties, sourceRefs: [] };
}

function buildOutput(relationships: ExtractedRelationship[]): ExtractionOutput {
  return {
    source: 'lps.md',
    sourcePath: '/corpus/lps.md',
    extractedAt: NOW,
    extractedBy: 'worker',
    entities: [
      entity('Zone', 'Residential Zone'),
      entity('LandUse', 'Shop'),
      entity('Provision', 'Setback Rule'),
    ],
    relationships,
  };
}

describe('VocabularyConformanceGate', () => {
  const nonConformingOutput = buildOutput([
    // Non-conforming closed-enum value: "I" is not in P/D/A/X.
    relationship('PERMITS', 'Residential Zone', 'Shop', { permissibility: 'I' }),
    // Bad endpoint type: a Provision is not an allowed PERMITS source.
    relationship('PERMITS', 'Setback Rule', 'Shop', { permissibility: 'P' }),
  ]);

  it('reports both the non-conforming closed-enum value and the endpoint issue', () => {
    const gate = new VocabularyConformanceGate(buildVocabulary(), 'managed');
    const report = gate.run([nonConformingOutput]);

    expect(report.countsByClass['closed-enum-value']).toBe(1);
    expect(report.countsByClass['endpoint-type']).toBe(1);
    expect(report.violationCount).toBe(2);

    const enumViolation = report.examples.find(v => v.class === 'closed-enum-value')!;
    expect(enumViolation.scope).toBe('relationship');
    expect(enumViolation.typeName).toBe('PERMITS');
    expect(enumViolation.message).toContain('permissibility');

    const endpointViolation = report.examples.find(v => v.class === 'endpoint-type')!;
    expect(endpointViolation.subject).toBe('Setback Rule → Shop');
  });

  it('under managed emits a vocabulary-extension recommendation for the unknown value', () => {
    const gate = new VocabularyConformanceGate(buildVocabulary(), 'managed');
    const report = gate.run([nonConformingOutput]);

    expect(report.severity).toBe('warn');
    expect(report.recommendations).toHaveLength(1);

    const rec = report.recommendations[0]!;
    expect(rec.scope).toBe('relationship');
    expect(rec.typeName).toBe('PERMITS');
    expect(rec.property).toBe('permissibility');
    expect(rec.currentEnumValues).toEqual(['P', 'D', 'A', 'X']);
    expect(rec.observedValues).toEqual([{ value: 'I', count: 1 }]);
    expect(rec.proposedEnumValues).toEqual(['P', 'D', 'A', 'X', 'I']);
  });

  it('under locked treats the same violations as failures and makes no recommendation', () => {
    const gate = new VocabularyConformanceGate(buildVocabulary(), 'locked');
    const report = gate.run([nonConformingOutput]);

    expect(report.severity).toBe('fail');
    expect(report.violationCount).toBe(2);
    expect(report.countsByClass['closed-enum-value']).toBe(1);
    expect(report.countsByClass['endpoint-type']).toBe(1);
    expect(report.recommendations).toEqual([]);
  });

  it('counts recurring closed-enum values across relationships', () => {
    const output = buildOutput([
      relationship('PERMITS', 'Residential Zone', 'Shop', { permissibility: 'I' }),
      relationship('PERMITS', 'Residential Zone', 'Shop', { permissibility: 'I' }),
      relationship('PERMITS', 'Residential Zone', 'Shop', { permissibility: 'S' }),
    ]);
    const gate = new VocabularyConformanceGate(buildVocabulary(), 'managed');
    const report = gate.run([output]);

    expect(report.countsByClass['closed-enum-value']).toBe(3);
    const rec = report.recommendations[0]!;
    expect(rec.observedValues).toEqual([
      { value: 'I', count: 2 },
      { value: 'S', count: 1 },
    ]);
    expect(rec.proposedEnumValues).toEqual(['P', 'D', 'A', 'X', 'I', 'S']);
  });

  it('reports no violations for conforming extraction output', () => {
    const output = buildOutput([
      relationship('PERMITS', 'Residential Zone', 'Shop', { permissibility: 'P' }),
    ]);
    const gate = new VocabularyConformanceGate(buildVocabulary(), 'managed');
    const report = gate.run([output]);

    expect(report.violationCount).toBe(0);
    expect(report.recommendations).toEqual([]);
    expect(report.totalRelationships).toBe(1);
    expect(report.totalEntities).toBe(3);
  });

  it('classifies a missing required property as required-property-missing', () => {
    const output = buildOutput([
      // PERMITS requires permissibility; omit it.
      relationship('PERMITS', 'Residential Zone', 'Shop', {}),
    ]);
    const gate = new VocabularyConformanceGate(buildVocabulary(), 'managed');
    const report = gate.run([output]);

    expect(report.countsByClass['required-property-missing']).toBe(1);
    expect(report.countsByClass['closed-enum-value']).toBe(0);
    expect(report.recommendations).toEqual([]);
    const violation = report.examples.find(v => v.class === 'required-property-missing')!;
    expect(violation.field).toBe('properties.permissibility');
  });

  it('classifies an unknown relationship type as unknown-type', () => {
    const output = buildOutput([
      relationship('FROBS', 'Residential Zone', 'Shop', {}),
    ]);
    const gate = new VocabularyConformanceGate(buildVocabulary(), 'managed');
    const report = gate.run([output]);

    expect(report.countsByClass['unknown-type']).toBe(1);
    const violation = report.examples.find(v => v.class === 'unknown-type')!;
    expect(violation.scope).toBe('relationship');
    expect(violation.field).toBe('relationshipType');
  });

  it('classifies an unknown property into the other bucket', () => {
    const output = buildOutput([
      relationship('PERMITS', 'Residential Zone', 'Shop', { permissibility: 'P', foo: 'bar' }),
    ]);
    const gate = new VocabularyConformanceGate(buildVocabulary(), 'managed');
    const report = gate.run([output]);

    expect(report.countsByClass.other).toBe(1);
    expect(report.countsByClass['closed-enum-value']).toBe(0);
    const violation = report.examples.find(v => v.class === 'other')!;
    expect(violation.field).toBe('properties.foo');
  });

  it('under open mode warns and makes no recommendation', () => {
    const gate = new VocabularyConformanceGate(buildVocabulary(), 'open');
    const report = gate.run([nonConformingOutput]);

    expect(report.severity).toBe('warn');
    expect(report.violationCount).toBe(2);
    expect(report.countsByClass['closed-enum-value']).toBe(1);
    expect(report.recommendations).toEqual([]);
  });

  it('does not raise an endpoint violation for an unresolved (orphan) endpoint label', () => {
    const output: ExtractionOutput = {
      ...buildOutput([
        // Target label matches no entity — an orphan, not an endpoint-type issue.
        relationship('PERMITS', 'Residential Zone', 'Ghost Use', { permissibility: 'P' }),
      ]),
    };
    const gate = new VocabularyConformanceGate(buildVocabulary(), 'managed');
    const report = gate.run([output]);

    expect(report.countsByClass['endpoint-type']).toBe(0);
    expect(report.violationCount).toBe(0);
  });
});
