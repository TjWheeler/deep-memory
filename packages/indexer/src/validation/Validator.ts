import type { ExtractionOutput, ExtractedEntity, ExtractedRelationship } from '../types/extraction.js';
import type {
  ValidationRules,
  ValidationResult,
  ValidationIssue,
  Tier1Result,
  PropertyRange,
} from '../types/validation.js';

/**
 * Tier 1 Validator — automated schema, range, and structural checks.
 *
 * Runs locally with zero LLM cost. Every extraction must pass Tier 1
 * before proceeding to consolidation.
 */
export class Validator {
  private readonly entityTypes: Set<string>;
  private readonly relationshipTypes: Set<string>;

  constructor(
    private readonly rules: ValidationRules,
    vocabulary: string,
  ) {
    // Parse entity and relationship types from the vocabulary text
    this.entityTypes = parseVocabularyTypes(vocabulary, 'entity');
    this.relationshipTypes = parseVocabularyTypes(vocabulary, 'relationship');
  }

  /**
   * Validate a single extraction output against schema, range, and structural rules.
   */
  validate(extraction: ExtractionOutput): ValidationResult {
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    // 1a. Schema validation
    this.validateSchema(extraction, errors, warnings);

    // 1b. Range validation
    this.validateRanges(extraction, errors, warnings);

    // 1c. Structural validation
    this.validateStructure(extraction, errors, warnings);

    const tier1: Tier1Result = {
      schemaErrors: errors.filter(e => e.message.includes('[schema]')).length,
      rangeViolations: errors.filter(e => e.message.includes('[range]')).length
        + warnings.filter(w => w.message.includes('[range]')).length,
      structuralIssues: errors.filter(e => e.message.includes('[structural]')).length
        + warnings.filter(w => w.message.includes('[structural]')).length,
      passed: errors.length === 0,
    };

    const overallVerdict: 'pass' | 'warnings' | 'fail' =
      errors.length > 0 ? 'fail' : warnings.length > 0 ? 'warnings' : 'pass';

    return {
      source: extraction.source,
      tier1,
      overallVerdict,
      errors,
      warnings,
    };
  }

  // ── 1a. Schema Validation ──────────────────────────────────────────

  private validateSchema(
    extraction: ExtractionOutput,
    errors: ValidationIssue[],
    _warnings: ValidationIssue[],
  ): void {
    for (const entity of extraction.entities) {
      // Check entity type exists in vocabulary
      if (this.entityTypes.size > 0 && !this.entityTypes.has(entity.entityType)) {
        errors.push({
          tier: 1,
          severity: 'error',
          entityLabel: entity.label,
          message: `[schema] Unknown entity type "${entity.entityType}" — not in vocabulary`,
          extractedValue: entity.entityType,
        });
      }

      // Check label is non-empty
      if (!entity.label.trim()) {
        errors.push({
          tier: 1,
          severity: 'error',
          entityLabel: entity.label,
          message: '[schema] Entity has empty label',
        });
      }
    }

    for (const rel of extraction.relationships) {
      // Check relationship type exists in vocabulary
      if (this.relationshipTypes.size > 0 && !this.relationshipTypes.has(rel.type)) {
        errors.push({
          tier: 1,
          severity: 'error',
          relationshipType: rel.type,
          message: `[schema] Unknown relationship type "${rel.type}" — not in vocabulary`,
          extractedValue: rel.type,
        });
      }

      // Check source/target labels are non-empty
      if (!rel.sourceLabel.trim()) {
        errors.push({
          tier: 1,
          severity: 'error',
          relationshipType: rel.type,
          message: '[schema] Relationship has empty sourceLabel',
        });
      }
      if (!rel.targetLabel.trim()) {
        errors.push({
          tier: 1,
          severity: 'error',
          relationshipType: rel.type,
          message: '[schema] Relationship has empty targetLabel',
        });
      }

      // Check source and target entities exist in this extraction
      const entityLabels = new Set(extraction.entities.map(e => e.label.toLowerCase()));
      if (!entityLabels.has(rel.sourceLabel.toLowerCase())) {
        errors.push({
          tier: 1,
          severity: 'error',
          relationshipType: rel.type,
          message: `[schema] Relationship source "${rel.sourceLabel}" not found in extracted entities`,
          extractedValue: rel.sourceLabel,
        });
      }
      if (!entityLabels.has(rel.targetLabel.toLowerCase())) {
        errors.push({
          tier: 1,
          severity: 'error',
          relationshipType: rel.type,
          message: `[schema] Relationship target "${rel.targetLabel}" not found in extracted entities`,
          extractedValue: rel.targetLabel,
        });
      }
    }
  }

  // ── 1b. Range Validation ───────────────────────────────────────────

  private validateRanges(
    extraction: ExtractionOutput,
    errors: ValidationIssue[],
    warnings: ValidationIssue[],
  ): void {
    // Validate entity property ranges
    for (const entity of extraction.entities) {
      const entityRanges = this.rules.propertyRanges[entity.entityType];
      if (!entityRanges) continue;

      for (const [propName, propValue] of Object.entries(entity.properties)) {
        const range = entityRanges[propName];
        if (!range) continue;

        this.checkPropertyRange(
          propName,
          propValue,
          range,
          errors,
          warnings,
          entity.label,
          undefined,
        );
      }
    }

    // Validate relationship property ranges
    for (const rel of extraction.relationships) {
      const relRanges = this.rules.relationshipRanges[rel.type];
      if (!relRanges) continue;

      for (const [propName, propValue] of Object.entries(rel.properties)) {
        const range = relRanges[propName];
        if (!range) continue;

        this.checkPropertyRange(
          propName,
          propValue,
          range,
          errors,
          warnings,
          undefined,
          rel.type,
        );
      }
    }
  }

  private checkPropertyRange(
    propName: string,
    propValue: unknown,
    range: PropertyRange,
    errors: ValidationIssue[],
    _warnings: ValidationIssue[],
    entityLabel?: string,
    relationshipType?: string,
  ): void {
    const numValue = toNumber(propValue);
    const context = entityLabel
      ? `entity "${entityLabel}"`
      : `relationship "${relationshipType}"`;

    if (range.type === 'number' || range.type === 'integer' || range.type === 'percentage') {
      if (numValue === null) {
        errors.push({
          tier: 1,
          severity: 'error',
          entityLabel,
          relationshipType,
          property: propName,
          message: `[range] ${context}: property "${propName}" should be numeric but got ${typeof propValue}: ${JSON.stringify(propValue)}`,
          extractedValue: propValue,
          expectedRange: formatRange(range),
        });
        return;
      }

      if (range.type === 'integer' && !Number.isInteger(numValue)) {
        errors.push({
          tier: 1,
          severity: 'error',
          entityLabel,
          relationshipType,
          property: propName,
          message: `[range] ${context}: property "${propName}" should be an integer but got ${numValue}`,
          extractedValue: propValue,
          expectedRange: formatRange(range),
        });
      }

      if (range.min !== undefined && numValue < range.min) {
        errors.push({
          tier: 1,
          severity: 'error',
          entityLabel,
          relationshipType,
          property: propName,
          message: `[range] ${context}: property "${propName}" value ${numValue} is below minimum ${range.min}`,
          extractedValue: propValue,
          expectedRange: formatRange(range),
        });
      }

      if (range.max !== undefined && numValue > range.max) {
        errors.push({
          tier: 1,
          severity: 'error',
          entityLabel,
          relationshipType,
          property: propName,
          message: `[range] ${context}: property "${propName}" value ${numValue} exceeds maximum ${range.max}`,
          extractedValue: propValue,
          expectedRange: formatRange(range),
        });
      }
    }

    if (range.type === 'string') {
      const strValue = String(propValue);

      if (range.pattern) {
        const regex = new RegExp(range.pattern);
        if (!regex.test(strValue)) {
          errors.push({
            tier: 1,
            severity: 'error',
            entityLabel,
            relationshipType,
            property: propName,
            message: `[range] ${context}: property "${propName}" value "${strValue}" does not match pattern ${range.pattern}`,
            extractedValue: propValue,
            expectedRange: `pattern: ${range.pattern}`,
          });
        }
      }

      if (range.enum && !range.enum.includes(strValue)) {
        errors.push({
          tier: 1,
          severity: 'error',
          entityLabel,
          relationshipType,
          property: propName,
          message: `[range] ${context}: property "${propName}" value "${strValue}" not in allowed values [${range.enum.join(', ')}]`,
          extractedValue: propValue,
          expectedRange: `one of: ${range.enum.join(', ')}`,
        });
      }
    }
  }

  // ── 1c. Structural Validation ──────────────────────────────────────

  private validateStructure(
    extraction: ExtractionOutput,
    errors: ValidationIssue[],
    warnings: ValidationIssue[],
  ): void {
    const { structuralRules } = this.rules;

    // Check sourceRefs on every entity
    for (const entity of extraction.entities) {
      if (entity.sourceRefs.length === 0) {
        errors.push({
          tier: 1,
          severity: 'error',
          entityLabel: entity.label,
          message: '[structural] Entity has no sourceRefs — provenance is not traceable',
        });
      }

      for (const ref of entity.sourceRefs) {
        if (ref.lineStart > ref.lineEnd) {
          errors.push({
            tier: 1,
            severity: 'error',
            entityLabel: entity.label,
            message: `[structural] Entity sourceRef has lineStart (${ref.lineStart}) > lineEnd (${ref.lineEnd})`,
          });
        }
        if (ref.lineStart <= 0 || ref.lineEnd <= 0) {
          errors.push({
            tier: 1,
            severity: 'error',
            entityLabel: entity.label,
            message: `[structural] Entity sourceRef has invalid line numbers (lineStart=${ref.lineStart}, lineEnd=${ref.lineEnd})`,
          });
        }
      }
    }

    // Check sourceRefs on every relationship
    for (const rel of extraction.relationships) {
      if (rel.sourceRefs.length === 0) {
        warnings.push({
          tier: 1,
          severity: 'warning',
          relationshipType: rel.type,
          message: `[structural] Relationship ${rel.type} (${rel.sourceLabel} → ${rel.targetLabel}) has no sourceRefs`,
        });
      }
    }

    // Check for duplicate entities within extraction
    const entityKeys = new Set<string>();
    for (const entity of extraction.entities) {
      const key = `${entity.entityType}:${entity.label.toLowerCase()}`;
      if (entityKeys.has(key)) {
        warnings.push({
          tier: 1,
          severity: 'warning',
          entityLabel: entity.label,
          message: `[structural] Duplicate entity within extraction: ${key}`,
        });
      }
      entityKeys.add(key);
    }

    // Check max entities per extraction
    if (structuralRules.maxEntitiesPerExtraction !== undefined
      && extraction.entities.length > structuralRules.maxEntitiesPerExtraction) {
      warnings.push({
        tier: 1,
        severity: 'warning',
        message: `[structural] Extraction has ${extraction.entities.length} entities, exceeding maximum of ${structuralRules.maxEntitiesPerExtraction}`,
      });
    }

    // Check max relationships per extraction
    if (structuralRules.maxRelationshipsPerExtraction !== undefined
      && extraction.relationships.length > structuralRules.maxRelationshipsPerExtraction) {
      warnings.push({
        tier: 1,
        severity: 'warning',
        message: `[structural] Extraction has ${extraction.relationships.length} relationships, exceeding maximum of ${structuralRules.maxRelationshipsPerExtraction}`,
      });
    }

    // Check orphan entities (entities not referenced in any relationship)
    if (structuralRules.noOrphans) {
      const referencedLabels = new Set<string>();
      for (const rel of extraction.relationships) {
        referencedLabels.add(rel.sourceLabel.toLowerCase());
        referencedLabels.add(rel.targetLabel.toLowerCase());
      }
      for (const entity of extraction.entities) {
        if (!referencedLabels.has(entity.label.toLowerCase())) {
          warnings.push({
            tier: 1,
            severity: 'warning',
            entityLabel: entity.label,
            message: `[structural] Orphan entity "${entity.label}" — not referenced by any relationship`,
          });
        }
      }
    }

    // Check required relationships
    if (structuralRules.requiredRelationships) {
      const relTypesByEntity = buildRelationshipMap(extraction.entities, extraction.relationships);

      for (const [entityType, requiredRelTypes] of Object.entries(structuralRules.requiredRelationships)) {
        const entitiesOfType = extraction.entities.filter(e => e.entityType === entityType);

        for (const entity of entitiesOfType) {
          const entityRelTypes = relTypesByEntity.get(entity.label.toLowerCase()) ?? new Set<string>();

          for (const reqRelType of requiredRelTypes) {
            if (!entityRelTypes.has(reqRelType)) {
              warnings.push({
                tier: 1,
                severity: 'warning',
                entityLabel: entity.label,
                message: `[structural] ${entityType} "${entity.label}" is missing required relationship ${reqRelType}`,
              });
            }
          }
        }
      }
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Extract numeric value from a potentially string-encoded number (e.g., "398 MT" → 398, "1,400 kW" → 1400) */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    // Strip commas from formatted numbers (e.g., "1,400" → "1400", "6,781 L" → "6781 L")
    const cleaned = value.replace(/,/g, '');

    // Handle percentage strings like "90%"
    const percentMatch = cleaned.match(/^([\d.]+)\s*%$/);
    if (percentMatch) return parseFloat(percentMatch[1]!);

    // Handle numeric strings with units like "398 MT" or "1400 kW (1875 HP)"
    const numMatch = cleaned.match(/^([\d.]+)/);
    if (numMatch) {
      const num = parseFloat(numMatch[1]!);
      if (!isNaN(num)) return num;
    }
  }
  return null;
}

/** Format a PropertyRange as a human-readable string */
function formatRange(range: PropertyRange): string {
  const parts: string[] = [range.type];
  if (range.unit) parts.push(`(${range.unit})`);
  if (range.min !== undefined && range.max !== undefined) {
    parts.push(`[${range.min}–${range.max}]`);
  } else if (range.min !== undefined) {
    parts.push(`≥ ${range.min}`);
  } else if (range.max !== undefined) {
    parts.push(`≤ ${range.max}`);
  }
  return parts.join(' ');
}

/**
 * Parse entity/relationship type names from vocabulary markdown text.
 * Looks for headings like "## Entity Types" / "## Relationship Types" and
 * extracts type names from sub-headings, bold items, and table cells.
 */
function parseVocabularyTypes(vocabulary: string, kind: 'entity' | 'relationship'): Set<string> {
  const types = new Set<string>();
  const lines = vocabulary.split('\n');

  const sectionPattern = kind === 'entity'
    ? /entity\s+type/i
    : /relationship\s+type/i;

  let inSection = false;
  let sectionDepth = 0;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);

    if (headingMatch) {
      const depth = headingMatch[1]!.length;

      if (sectionPattern.test(headingMatch[2]!)) {
        inSection = true;
        sectionDepth = depth;
        continue;
      }

      // A heading at the same or higher level ends the section
      if (inSection && depth <= sectionDepth) {
        inSection = false;
        continue;
      }

      // Sub-headings within the section are type names (for entity types like ### Equipment)
      if (inSection && depth > sectionDepth) {
        const typeName = headingMatch[2]!.replace(/[*`]/g, '').trim();
        // Skip category headings like "Core Relationships", "Component Relationships"
        if (typeName && !typeName.toLowerCase().includes('relationship') && !typeName.toLowerCase().includes('properties for')) {
          types.add(typeName);
        }
      }
    }

    if (inSection) {
      // Bold items (e.g., **Equipment**)
      const boldMatch = line.match(/\*\*([A-Z][A-Za-z_]+)\*\*/);
      if (boldMatch) {
        types.add(boldMatch[1]!);
      }

      // Table cells with backtick-code type names (e.g., | `MANUFACTURED_BY` | ... |)
      // This pattern matches relationship types defined in markdown tables
      const tableCodeMatches = line.matchAll(/\|\s*`([A-Z][A-Z_]+)`\s*\|/g);
      for (const match of tableCodeMatches) {
        types.add(match[1]!);
      }
    }
  }

  return types;
}

/** Build a map of entity label → set of relationship types it participates in */
function buildRelationshipMap(
  entities: ExtractedEntity[],
  relationships: ExtractedRelationship[],
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();

  for (const entity of entities) {
    map.set(entity.label.toLowerCase(), new Set());
  }

  for (const rel of relationships) {
    const sourceSet = map.get(rel.sourceLabel.toLowerCase());
    if (sourceSet) sourceSet.add(rel.type);

    const targetSet = map.get(rel.targetLabel.toLowerCase());
    if (targetSet) targetSet.add(rel.type);
  }

  return map;
}
