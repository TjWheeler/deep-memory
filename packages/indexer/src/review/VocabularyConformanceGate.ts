/**
 * Vocabulary conformance gate.
 *
 * Validates extraction output against the domain vocabulary before
 * consolidation, reusing core's `validateEntity` / `validateRelationship` — the
 * same contract the live repository enforces. It adds no type, endpoint, or
 * enum logic of its own; it adapts extraction shapes to core's inputs, groups
 * the resulting violations into reporting classes, and derives structured
 * vocabulary-extension recommendations from recurring closed-enum values.
 *
 * How a violation is treated depends on the governance mode:
 *   - `locked`  → violations are failures.
 *   - `managed` → violations are warnings, and a non-conforming closed-enum
 *                 value surfaces a vocabulary-extension recommendation so the
 *                 too-narrow contract can be widened deliberately.
 *   - `open`    → violations are warnings.
 *
 * Pure computation — no LLM calls, no I/O. Runs at the extract→consolidate
 * boundary and from the diagnose tool, where there is no live repository, so it
 * recommends rather than mutating vocabulary.
 */

import {
  validateEntity,
  validateRelationship,
  getEntityTypeDef,
  getRelationshipTypeDef,
} from '@utaba/deep-memory';
import type {
  MemoryVocabulary,
  GovernanceMode,
  CreateEntityInput,
  CreateRelationshipInput,
  ValidationError,
  PropertySchema,
} from '@utaba/deep-memory';
import type {
  ExtractionOutput,
  ExtractedEntity,
  ExtractedRelationship,
} from '../types/extraction.js';

/** The class a conformance violation falls into */
export type ConformanceViolationClass =
  | 'unknown-type'
  | 'endpoint-type'
  | 'required-property-missing'
  | 'closed-enum-value'
  | 'other';

/** Whether violations block (locked) or merely warn (managed / open) */
export type ConformanceSeverity = 'fail' | 'warn';

/** A single conformance violation against the vocabulary */
export interface ConformanceViolation {
  class: ConformanceViolationClass;
  scope: 'entity' | 'relationship';
  /** The vocabulary type involved (or the offending input type when unknown) */
  typeName: string;
  /** Entity label, or "source → target" for a relationship */
  subject: string;
  /** The field core flagged (e.g. "properties.permissibility") */
  field: string;
  message: string;
  /** Source document the extraction came from */
  source: string;
}

/**
 * A structured recommendation to widen a closed enum, derived from
 * non-conforming values seen in the corpus. Carries everything needed to
 * action it later against a live repository without re-scanning the data.
 */
export interface VocabularyExtensionRecommendation {
  scope: 'entity' | 'relationship';
  /** The entity or relationship type carrying the closed-enum property */
  typeName: string;
  /** The closed-enum property */
  property: string;
  /** The currently declared allowed values */
  currentEnumValues: string[];
  /** Non-conforming values observed, with their occurrence counts */
  observedValues: Array<{ value: string; count: number }>;
  /** Proposed allowed set: current values plus the observed non-conforming ones */
  proposedEnumValues: string[];
}

/** Result of running the conformance gate over extraction outputs */
export interface ConformanceReport {
  mode: GovernanceMode;
  /** How violations are treated under the mode */
  severity: ConformanceSeverity;
  totalEntities: number;
  totalRelationships: number;
  violationCount: number;
  /** Violation counts grouped by class */
  countsByClass: Record<ConformanceViolationClass, number>;
  /** Capped sample of violations for reporting */
  examples: ConformanceViolation[];
  /** Vocabulary-extension recommendations (managed mode only) */
  recommendations: VocabularyExtensionRecommendation[];
}

/**
 * Maximum violation examples carried in a report per violation class. Capping
 * per class rather than in total stops the first-processed classes (entities are
 * checked before relationships) from starving later classes of examples — every
 * class that occurs keeps a representative sample.
 */
const MAX_EXAMPLES_PER_CLASS = 5;

/** Accumulator for one (scope, type, property) closed-enum offender group */
interface EnumOffenderGroup {
  scope: 'entity' | 'relationship';
  typeName: string;
  property: string;
  currentEnumValues: string[];
  counts: Map<string, number>;
}

export class VocabularyConformanceGate {
  private readonly vocabulary: MemoryVocabulary;
  private readonly mode: GovernanceMode;
  /**
   * Minimum times a non-conforming closed-enum value must appear across the
   * corpus before it is recommended as a vocabulary extension. Defaults to 1:
   * any distinct out-of-enum value is a candidate for widening the contract.
   */
  private readonly recommendationMinCount: number;

  public constructor(
    vocabulary: MemoryVocabulary,
    mode: GovernanceMode,
    recommendationMinCount = 1,
  ) {
    this.vocabulary = vocabulary;
    this.mode = mode;
    this.recommendationMinCount = recommendationMinCount;
  }

  /** Run the gate over a set of extraction outputs and produce a report */
  public run(outputs: ExtractionOutput[]): ConformanceReport {
    const severity: ConformanceSeverity = this.mode === 'locked' ? 'fail' : 'warn';

    const countsByClass: Record<ConformanceViolationClass, number> = {
      'unknown-type': 0,
      'endpoint-type': 0,
      'required-property-missing': 0,
      'closed-enum-value': 0,
      other: 0,
    };
    const examples: ConformanceViolation[] = [];
    const exampleCountByClass: Record<ConformanceViolationClass, number> = {
      'unknown-type': 0,
      'endpoint-type': 0,
      'required-property-missing': 0,
      'closed-enum-value': 0,
      other: 0,
    };
    const enumOffenders = new Map<string, EnumOffenderGroup>();

    let totalEntities = 0;
    let totalRelationships = 0;
    let violationCount = 0;

    const record = (violation: ConformanceViolation): void => {
      countsByClass[violation.class] += 1;
      violationCount += 1;
      if (exampleCountByClass[violation.class] < MAX_EXAMPLES_PER_CLASS) {
        exampleCountByClass[violation.class] += 1;
        examples.push(violation);
      }
    };

    for (const output of outputs) {
      const labelToType = this.buildLabelTypeMap(output.entities);

      for (const entity of output.entities) {
        totalEntities += 1;
        this.checkEntity(entity, output.source, record, enumOffenders);
      }

      for (const rel of output.relationships) {
        totalRelationships += 1;
        this.checkRelationship(rel, labelToType, output.source, record, enumOffenders);
      }
    }

    const recommendations =
      this.mode === 'managed' ? this.buildRecommendations(enumOffenders) : [];

    return {
      mode: this.mode,
      severity,
      totalEntities,
      totalRelationships,
      violationCount,
      countsByClass,
      examples,
      recommendations,
    };
  }

  // ── Entity conformance ──────────────────────────────────────────

  private checkEntity(
    entity: ExtractedEntity,
    source: string,
    record: (v: ConformanceViolation) => void,
    enumOffenders: Map<string, EnumOffenderGroup>,
  ): void {
    const input: CreateEntityInput = {
      entityType: entity.entityType,
      label: entity.label,
      summary: entity.summary,
      properties: entity.properties,
    };

    const result = validateEntity(input, this.vocabulary);
    if (result.valid) return;

    const typeDef = getEntityTypeDef(entity.entityType, this.vocabulary);
    for (const error of result.errors) {
      const violationClass = this.classifyError(error, entity.properties, typeDef?.properties);
      record({
        class: violationClass,
        scope: 'entity',
        typeName: entity.entityType,
        subject: entity.label,
        field: error.field,
        message: error.message,
        source,
      });
      if (violationClass === 'closed-enum-value') {
        this.accumulateEnumOffender('entity', entity.entityType, error.field, entity.properties, typeDef?.properties, enumOffenders);
      }
    }
  }

  // ── Relationship conformance ────────────────────────────────────

  private checkRelationship(
    rel: ExtractedRelationship,
    labelToType: Map<string, string>,
    source: string,
    record: (v: ConformanceViolation) => void,
    enumOffenders: Map<string, EnumOffenderGroup>,
  ): void {
    const sourceType = labelToType.get(rel.sourceLabel.toLowerCase());
    const targetType = labelToType.get(rel.targetLabel.toLowerCase());

    const input: CreateRelationshipInput = {
      relationshipType: rel.type,
      sourceEntityId: rel.sourceLabel,
      targetEntityId: rel.targetLabel,
      properties: rel.properties,
    };

    const result = validateRelationship(
      input,
      this.vocabulary,
      sourceType ?? '',
      targetType ?? '',
    );
    if (result.valid) return;

    const typeDef = getRelationshipTypeDef(rel.type, this.vocabulary);
    const subject = `${rel.sourceLabel} → ${rel.targetLabel}`;
    const typeName = typeDef?.type ?? rel.type;

    for (const error of result.errors) {
      // An endpoint error caused purely by an unresolved (orphan) label is not
      // a conformance issue — orphan endpoints are the review diagnostics'
      // concern. Skip those so the gate only reports genuinely disallowed types.
      if (error.field === 'sourceEntityId' && sourceType === undefined) continue;
      if (error.field === 'targetEntityId' && targetType === undefined) continue;

      const violationClass = this.classifyError(error, rel.properties, typeDef?.properties);
      record({
        class: violationClass,
        scope: 'relationship',
        typeName,
        subject,
        field: error.field,
        message: error.message,
        source,
      });
      if (violationClass === 'closed-enum-value') {
        this.accumulateEnumOffender('relationship', typeName, error.field, rel.properties, typeDef?.properties, enumOffenders);
      }
    }
  }

  // ── Classification ──────────────────────────────────────────────

  /**
   * Map a core validation error to a reporting class. Core owns the valid/
   * invalid decision; this only buckets the error using the field it flagged
   * and the vocabulary schema — it does not re-validate.
   */
  private classifyError(
    error: ValidationError,
    properties: Record<string, unknown> | undefined,
    schemas: PropertySchema[] | undefined,
  ): ConformanceViolationClass {
    if (error.field === 'entityType' || error.field === 'relationshipType') {
      return 'unknown-type';
    }
    if (error.field === 'sourceEntityId' || error.field === 'targetEntityId') {
      return 'endpoint-type';
    }

    if (error.field.startsWith('properties.')) {
      const name = error.field.slice('properties.'.length);
      const schema = schemas?.find(s => s.name === name);
      const value = properties?.[name];

      if (schema?.required && (value === undefined || value === null)) {
        return 'required-property-missing';
      }
      if (
        schema?.type === 'enum' &&
        schema.enumValues !== undefined &&
        typeof value === 'string' &&
        !schema.enumValues.includes(value)
      ) {
        return 'closed-enum-value';
      }
    }

    return 'other';
  }

  // ── Recommendation accumulation ─────────────────────────────────

  private accumulateEnumOffender(
    scope: 'entity' | 'relationship',
    typeName: string,
    field: string,
    properties: Record<string, unknown> | undefined,
    schemas: PropertySchema[] | undefined,
    enumOffenders: Map<string, EnumOffenderGroup>,
  ): void {
    const name = field.slice('properties.'.length);
    const schema = schemas?.find(s => s.name === name);
    const value = properties?.[name];
    if (schema?.enumValues === undefined || typeof value !== 'string') return;

    const key = `${scope}|${typeName}|${name}`;
    let group = enumOffenders.get(key);
    if (!group) {
      group = {
        scope,
        typeName,
        property: name,
        currentEnumValues: schema.enumValues,
        counts: new Map<string, number>(),
      };
      enumOffenders.set(key, group);
    }
    group.counts.set(value, (group.counts.get(value) ?? 0) + 1);
  }

  private buildRecommendations(
    enumOffenders: Map<string, EnumOffenderGroup>,
  ): VocabularyExtensionRecommendation[] {
    const recommendations: VocabularyExtensionRecommendation[] = [];
    for (const group of enumOffenders.values()) {
      const observedValues = [...group.counts.entries()]
        .filter(([, count]) => count >= this.recommendationMinCount)
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count);
      if (observedValues.length === 0) continue;

      const proposedEnumValues = [
        ...group.currentEnumValues,
        ...observedValues
          .map(o => o.value)
          .filter(v => !group.currentEnumValues.includes(v)),
      ];

      recommendations.push({
        scope: group.scope,
        typeName: group.typeName,
        property: group.property,
        currentEnumValues: group.currentEnumValues,
        observedValues,
        proposedEnumValues,
      });
    }
    return recommendations;
  }

  // ── Helpers ─────────────────────────────────────────────────────

  /**
   * Build a case-insensitive label→entityType map from entity labels and
   * aliases, so a relationship's endpoint labels resolve to their entity types
   * for endpoint validation. Mirrors the review diagnostics' orphan lookup.
   */
  private buildLabelTypeMap(entities: ExtractedEntity[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const entity of entities) {
      map.set(entity.label.toLowerCase(), entity.entityType);
      // Persisted extraction JSON may predate the aliases field or be partial —
      // guard before iterating so a missing array does not throw.
      if (entity.aliases) {
        for (const alias of entity.aliases) {
          const key = alias.toLowerCase();
          if (!map.has(key)) {
            map.set(key, entity.entityType);
          }
        }
      }
    }
    return map;
  }
}
