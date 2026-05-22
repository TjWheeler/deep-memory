/**
 * Parses a vocabulary markdown document into a structured MemoryVocabulary.
 *
 * Handles the standard vocabulary.md format from starter kits:
 * - ## Entity Types → ### TypeName → property tables, descriptions
 * - ## Relationship Types → group tables → optional property subsections
 *
 * Also supports augmenting the parsed vocabulary with types inferred
 * from actual entity/relationship data (for open governance extensions).
 */

import type {
  MemoryVocabulary,
  EntityTypeDefinition,
  RelationshipTypeDefinition,
  PropertySchema,
  PropertyType,
  StoredEntity,
  StoredRelationship,
} from '@utaba/deep-memory';

const ACTOR = 'indexer-vocabulary-parser';

/**
 * Parse a vocabulary markdown string into a MemoryVocabulary.
 * Returns an empty vocabulary if the markdown has no recognizable sections.
 */
export function parseVocabularyMarkdown(markdown: string): MemoryVocabulary {
  const now = new Date().toISOString();
  const entityTypes = parseEntityTypes(markdown, now);
  const relationshipTypes = parseRelationshipTypes(markdown, now);

  return {
    version: '1.0.0',
    lastModified: now,
    modifiedBy: ACTOR,
    entityTypes,
    relationshipTypes,
  };
}

/**
 * Augment a vocabulary with type definitions inferred from actual data.
 * Any entity type or relationship type present in the data but missing
 * from the vocabulary gets a minimal definition added.
 */
export function augmentVocabularyFromData(
  vocabulary: MemoryVocabulary,
  entities: StoredEntity[],
  relationships: StoredRelationship[],
): MemoryVocabulary {
  const now = new Date().toISOString();
  const existingEntityTypes = new Set(vocabulary.entityTypes.map(t => t.type));
  const existingRelTypes = new Set(vocabulary.relationshipTypes.map(t => t.type));

  const newEntityTypes: EntityTypeDefinition[] = [];
  const newRelTypes: RelationshipTypeDefinition[] = [];

  // Collect entity types and their observed properties
  const entityTypeProps = new Map<string, Map<string, Set<string>>>();
  for (const entity of entities) {
    if (existingEntityTypes.has(entity.entityType)) continue;

    if (!entityTypeProps.has(entity.entityType)) {
      entityTypeProps.set(entity.entityType, new Map());
    }
    const propMap = entityTypeProps.get(entity.entityType)!;
    for (const [key, value] of Object.entries(entity.properties)) {
      if (!propMap.has(key)) {
        propMap.set(key, new Set());
      }
      propMap.get(key)!.add(typeof value);
    }
  }

  for (const [typeName, propMap] of entityTypeProps) {
    const properties: PropertySchema[] = [];
    for (const [propName, jsTypes] of propMap) {
      properties.push({
        name: propName,
        type: inferPropertyType(jsTypes),
        required: false,
        description: `Observed in imported data`,
      });
    }
    newEntityTypes.push({
      type: typeName,
      description: `Inferred from imported entities`,
      version: '1.0.0',
      properties,
      createdAt: now,
      createdBy: ACTOR,
      modifiedAt: now,
      modifiedBy: ACTOR,
    });
  }

  // Collect relationship types and their source/target entity types
  const relTypeInfo = new Map<string, { sources: Set<string>; targets: Set<string>; props: Map<string, Set<string>> }>();
  const entityIdToType = new Map<string, string>();
  for (const entity of entities) {
    entityIdToType.set(entity.id, entity.entityType);
  }

  for (const rel of relationships) {
    if (existingRelTypes.has(rel.relationshipType)) continue;

    if (!relTypeInfo.has(rel.relationshipType)) {
      relTypeInfo.set(rel.relationshipType, { sources: new Set(), targets: new Set(), props: new Map() });
    }
    const info = relTypeInfo.get(rel.relationshipType)!;
    const sourceType = entityIdToType.get(rel.sourceEntityId);
    const targetType = entityIdToType.get(rel.targetEntityId);
    if (sourceType) info.sources.add(sourceType);
    if (targetType) info.targets.add(targetType);
    for (const [key, value] of Object.entries(rel.properties)) {
      if (!info.props.has(key)) {
        info.props.set(key, new Set());
      }
      info.props.get(key)!.add(typeof value);
    }
  }

  for (const [typeName, info] of relTypeInfo) {
    const properties: PropertySchema[] = [];
    for (const [propName, jsTypes] of info.props) {
      properties.push({
        name: propName,
        type: inferPropertyType(jsTypes),
        required: false,
        description: `Observed in imported data`,
      });
    }
    newRelTypes.push({
      type: typeName,
      description: `Inferred from imported relationships`,
      version: '1.0.0',
      allowedSourceTypes: [...info.sources],
      allowedTargetTypes: [...info.targets],
      bidirectional: false,
      properties,
      createdAt: now,
      createdBy: ACTOR,
      modifiedAt: now,
      modifiedBy: ACTOR,
    });
  }

  if (newEntityTypes.length === 0 && newRelTypes.length === 0) {
    return vocabulary;
  }

  return {
    ...vocabulary,
    entityTypes: [...vocabulary.entityTypes, ...newEntityTypes],
    relationshipTypes: [...vocabulary.relationshipTypes, ...newRelTypes],
    lastModified: now,
    modifiedBy: ACTOR,
  };
}

// ── Entity Type Parsing ──────────────────────────────────────────

function parseEntityTypes(markdown: string, now: string): EntityTypeDefinition[] {
  const entityTypesMatch = markdown.match(/^## Entity Types\s*$/m);
  if (!entityTypesMatch || entityTypesMatch.index === undefined) return [];

  const entityTypesStart = entityTypesMatch.index;
  const afterStart = entityTypesStart + entityTypesMatch[0].length;

  // End at next ## heading or end of file
  const nextH2Match = markdown.slice(afterStart).match(/^## [^#]/m);
  const entityTypesEnd = nextH2Match?.index !== undefined
    ? afterStart + nextH2Match.index
    : markdown.length;

  const content = markdown.slice(entityTypesStart, entityTypesEnd);

  // Split into per-entity-type sections by ### headings
  const h3Pattern = /^### (.+)$/gm;
  const h3Matches: Array<{ name: string; index: number }> = [];
  let h3Match;
  while ((h3Match = h3Pattern.exec(content)) !== null) {
    h3Matches.push({ name: h3Match[1]!.trim(), index: h3Match.index });
  }

  const definitions: EntityTypeDefinition[] = [];
  for (let i = 0; i < h3Matches.length; i++) {
    const current = h3Matches[i]!;
    const nextStart = i + 1 < h3Matches.length ? h3Matches[i + 1]!.index : content.length;
    const sectionContent = content.slice(current.index + current.name.length + 4, nextStart);

    const description = extractDescription(sectionContent);
    const properties = parsePropertyTable(sectionContent);

    definitions.push({
      type: current.name,
      description,
      version: '1.0.0',
      properties,
      createdAt: now,
      createdBy: ACTOR,
      modifiedAt: now,
      modifiedBy: ACTOR,
    });
  }

  return definitions;
}

// ── Relationship Type Parsing ────────────────────────────────────

function parseRelationshipTypes(markdown: string, now: string): RelationshipTypeDefinition[] {
  const relTypesMatch = markdown.match(/^## Relationship Types\s*$/m);
  if (!relTypesMatch || relTypesMatch.index === undefined) return [];

  const relTypesStart = relTypesMatch.index;
  const afterStart = relTypesStart + relTypesMatch[0].length;

  // End at next ## heading (e.g., ## Design Notes) or end of file
  const nextH2Match = markdown.slice(afterStart).match(/^## [^#]/m);
  const relTypesEnd = nextH2Match?.index !== undefined
    ? afterStart + nextH2Match.index
    : markdown.length;

  const content = markdown.slice(relTypesStart, relTypesEnd);

  // Parse relationship tables — they have columns: Type | Description | Source → Target | Bidirectional
  const definitions: RelationshipTypeDefinition[] = [];
  const relTablePattern = /^\|[^|]*Type[^|]*\|[^|]*Description[^|]*\|[^|]*Source[^|]*Target[^|]*\|[^|]*Bidirectional[^|]*\|/gm;
  let tableMatch;

  while ((tableMatch = relTablePattern.exec(content)) !== null) {
    const afterHeader = content.slice(tableMatch.index + tableMatch[0].length);
    const tableRows = extractTableRows(afterHeader);

    for (const row of tableRows) {
      if (row.length < 4) continue;

      const typeName = stripBackticks(row[0]!);
      const description = row[1]!;
      const sourceTarget = row[2]!;
      const bidirectional = row[3]!.toLowerCase().trim() === 'yes';

      // Parse "Source → Target" — may have multiple sources/targets
      const { sources, targets } = parseSourceTarget(sourceTarget);

      definitions.push({
        type: typeName,
        description,
        version: '1.0.0',
        allowedSourceTypes: sources,
        allowedTargetTypes: targets,
        bidirectional,
        properties: [],
        createdAt: now,
        createdBy: ACTOR,
        modifiedAt: now,
        modifiedBy: ACTOR,
      });
    }
  }

  // Parse relationship property subsections: #### Properties for `TYPE_NAME`
  const propSectionPattern = /^#### Properties for `([^`]+)`/gm;
  let propMatch;
  while ((propMatch = propSectionPattern.exec(content)) !== null) {
    const relType = propMatch[1]!;
    const afterHeading = content.slice(propMatch.index + propMatch[0].length);

    // Find the next heading or end of section
    const nextHeadingMatch = afterHeading.match(/^#{3,4} /m);
    const sectionEnd = nextHeadingMatch?.index !== undefined
      ? nextHeadingMatch.index
      : afterHeading.length;

    const sectionContent = afterHeading.slice(0, sectionEnd);
    const properties = parsePropertyTable(sectionContent);

    // Attach properties to the matching relationship definition
    const def = definitions.find(d => d.type === relType);
    if (def) {
      def.properties = properties;
    }
  }

  return definitions;
}

// ── Shared Parsing Helpers ───────────────────────────────────────

/** Extract description text between the heading and the first table or sub-heading */
function extractDescription(sectionContent: string): string {
  const lines = sectionContent.split('\n');
  const descLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Stop at table, sub-heading, or "**Label convention" / "**Recommended" patterns
    if (trimmed.startsWith('|') || trimmed.startsWith('#') || trimmed.startsWith('**')) break;
    if (trimmed === '---') continue;
    if (trimmed.length > 0) {
      descLines.push(trimmed);
    }
  }

  return descLines.join(' ').trim() || 'No description available';
}

/** Parse a markdown property table with columns: Property | Type | Required | Description */
function parsePropertyTable(sectionContent: string): PropertySchema[] {
  const properties: PropertySchema[] = [];

  // Find property table header
  const headerPattern = /^\|[^|]*Property[^|]*\|[^|]*Type[^|]*\|[^|]*Required[^|]*\|[^|]*Description[^|]*\|/gm;
  const headerMatch = headerPattern.exec(sectionContent);
  if (!headerMatch) return properties;

  const afterHeader = sectionContent.slice(headerMatch.index + headerMatch[0].length);
  const rows = extractTableRows(afterHeader);

  for (const row of rows) {
    if (row.length < 4) continue;

    const name = stripBackticks(row[0]!);
    const typeStr = row[1]!.toLowerCase().trim();
    const requiredStr = row[2]!.toLowerCase().trim();
    const description = row[3]!;

    properties.push({
      name,
      type: mapPropertyType(typeStr),
      required: requiredStr === 'yes',
      description: description || undefined,
    });
  }

  return properties;
}

/** Extract data rows from a markdown table (skipping the separator row) */
function extractTableRows(afterHeader: string): string[][] {
  const rows: string[][] = [];
  const lines = afterHeader.split('\n');

  let pastSeparator = false;
  for (const line of lines) {
    const trimmed = line.trim();

    // Separator row (|---|---|...)
    if (!pastSeparator && /^\|[\s-|:]+\|$/.test(trimmed)) {
      pastSeparator = true;
      continue;
    }

    // Data row
    if (pastSeparator && trimmed.startsWith('|')) {
      const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
      if (cells.length > 0 && cells.some(c => c.length > 0)) {
        rows.push(cells);
      }
      continue;
    }

    // End of table
    if (pastSeparator && !trimmed.startsWith('|')) {
      break;
    }
  }

  return rows;
}

/** Strip backticks from a cell value */
function stripBackticks(value: string): string {
  return value.replace(/`/g, '').trim();
}

/** Map markdown type strings to PropertyType */
function mapPropertyType(typeStr: string): PropertyType {
  switch (typeStr) {
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'date': return 'date';
    case 'enum': return 'enum';
    default: return 'string';
  }
}

/** Infer PropertyType from observed JavaScript typeof values */
function inferPropertyType(jsTypes: Set<string>): PropertyType {
  if (jsTypes.size === 1) {
    const t = [...jsTypes][0]!;
    if (t === 'number') return 'number';
    if (t === 'boolean') return 'boolean';
  }
  return 'string';
}

/** Parse "SourceType → TargetType" notation, handling comma-separated types */
function parseSourceTarget(sourceTarget: string): { sources: string[]; targets: string[] } {
  // Split on → (Unicode arrow) or -> (ASCII)
  const parts = sourceTarget.split(/\s*(?:→|->)\s*/);
  if (parts.length !== 2) {
    return { sources: [], targets: [] };
  }
  const sources = parts[0]!.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
  const targets = parts[1]!.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
  return { sources, targets };
}
