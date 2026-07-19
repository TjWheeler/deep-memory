import { parseVocabularyMarkdown } from '../consolidation/VocabularyMarkdownParser.js';

/**
 * Parses a vocabulary markdown document and produces a concise summary for the
 * full-validation prompt. Two sections are composed:
 *
 * 1. **Classification Properties** — properties whose values come from a controlled
 *    vocabulary rather than verbatim source text, so the validator does not flag a
 *    reasonable categorization just because the exact string is absent from the source.
 * 2. **Vocabulary Types** — the entity and relationship types (with endpoint constraints
 *    and required properties) the validator may use when proposing a structural remodel.
 *    Without this the validator cannot pick a valid type for a create/retarget proposal.
 *
 * Both sections are domain-agnostic — they are derived from whatever vocabulary the run
 * declares, so no domain type name is ever hardcoded here.
 */
export function summarizeVocabularyForValidation(vocabularyMarkdown: string): string {
  const classificationSection = buildClassificationSection(vocabularyMarkdown);
  const typesSection = buildTypesSection(vocabularyMarkdown);

  const sections = [classificationSection, typesSection].filter(s => s.length > 0);
  return sections.join('\n');
}

function buildClassificationSection(vocabularyMarkdown: string): string {
  const entitySections = parseEntitySections(vocabularyMarkdown);
  const withClassification = entitySections.filter(s => s.classificationProperties.length > 0);
  if (withClassification.length === 0) {
    return '';
  }

  const lines: string[] = [
    '## Vocabulary Classification Properties',
    '',
    'The extraction pipeline uses a controlled vocabulary. Properties listed below use',
    'standardized category values assigned during extraction — they are NOT expected to',
    'appear verbatim in source documents. A classification value is valid if it is a',
    'reasonable categorization given the source context, even if the exact string does',
    'not appear in the source text.',
    '',
    'These are recommended values, not strict enums. Any string is accepted when none',
    'of the recommended values fit.',
    '',
  ];

  for (const section of withClassification) {
    lines.push(`### ${section.entityType}`);
    for (const prop of section.classificationProperties) {
      const values = prop.recommendedValues.join(', ');
      lines.push(`- \`${prop.name}\`: ${values}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build the type catalogue a validator needs to ground a structural remodel: the
 * available entity types (with a one-line description and their required properties)
 * and relationship types (with their `Source → Target` endpoint constraint and required
 * properties). Kept token-conscious — only required properties are listed, and closed
 * enums surface their allowed set so a proposed create can carry a valid value.
 */
function buildTypesSection(vocabularyMarkdown: string): string {
  const vocab = parseVocabularyMarkdown(vocabularyMarkdown);
  if (vocab.entityTypes.length === 0 && vocab.relationshipTypes.length === 0) {
    return '';
  }

  const lines: string[] = [
    '## Vocabulary Types',
    '',
    'When you propose a structural remodel, every created or retargeted item must use a',
    'type from these lists, spelled exactly as shown. Endpoint constraints and required',
    'properties are enforced when the remodel is applied — a proposal that violates them',
    'is rejected.',
    '',
  ];

  if (vocab.entityTypes.length > 0) {
    lines.push('### Entity Types');
    for (const et of vocab.entityTypes) {
      lines.push(`- \`${et.type}\`${describe(et.description)}${requiredPropsSuffix(et.properties)}`);
    }
    lines.push('');
  }

  if (vocab.relationshipTypes.length > 0) {
    lines.push('### Relationship Types');
    for (const rt of vocab.relationshipTypes) {
      const sources = rt.allowedSourceTypes.length > 0 ? rt.allowedSourceTypes.join(' | ') : 'any';
      const targets = rt.allowedTargetTypes.length > 0 ? rt.allowedTargetTypes.join(' | ') : 'any';
      lines.push(`- \`${rt.type}\`: ${sources} → ${targets}${requiredPropsSuffix(rt.properties)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** A vocabulary property as produced by {@link parseVocabularyMarkdown}. */
interface ParsedProperty {
  name: string;
  type: string;
  required: boolean;
  enumValues?: string[];
}

/** First sentence of a description, trimmed to keep the prompt compact. */
function describe(description: string | undefined): string {
  if (!description) return '';
  const collapsed = description.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0 || collapsed === 'No description available') return '';
  const firstSentence = collapsed.split(/(?<=\.)\s/)[0] ?? collapsed;
  const oneLine = firstSentence.length > 120 ? `${firstSentence.slice(0, 117)}...` : firstSentence;
  return ` — ${oneLine}`;
}

/** " Required: `a`, `b (one of: x, y)`" — or "" when the type has no required properties. */
function requiredPropsSuffix(properties: ParsedProperty[] | undefined): string {
  const required = (properties ?? []).filter(p => p.required);
  if (required.length === 0) return '';
  const rendered = required.map(p => {
    if (p.type === 'enum' && p.enumValues && p.enumValues.length > 0) {
      return `\`${p.name}\` (one of: ${p.enumValues.join(', ')})`;
    }
    return `\`${p.name}\``;
  });
  return `. Required: ${rendered.join(', ')}`;
}

interface ClassificationProperty {
  name: string;
  recommendedValues: string[];
}

interface EntitySection {
  entityType: string;
  classificationProperties: ClassificationProperty[];
}

/**
 * Parse entity type sections from the vocabulary markdown.
 * Looks for ### headings under ## Entity Types, then finds property tables
 * and "Recommended `X` values" tables within each section.
 */
function parseEntitySections(markdown: string): EntitySection[] {
  const sections: EntitySection[] = [];

  // Find the Entity Types section
  const entityTypesMatch = markdown.match(/^## Entity Types\s*$/m);
  if (!entityTypesMatch || entityTypesMatch.index === undefined) return sections;

  const entityTypesStart = entityTypesMatch.index;

  // Find where Entity Types section ends (next ## heading or end of file)
  const nextH2Match = markdown.slice(entityTypesStart + entityTypesMatch[0].length)
    .match(/^## [^#]/m);
  const entityTypesEnd = nextH2Match && nextH2Match.index !== undefined
    ? entityTypesStart + entityTypesMatch[0].length + nextH2Match.index
    : markdown.length;

  const entityTypesContent = markdown.slice(entityTypesStart, entityTypesEnd);

  // Split into per-entity-type sections by ### headings
  const h3Pattern = /^### (.+)$/gm;
  const h3Matches: Array<{ name: string; index: number }> = [];
  let h3Match;
  while ((h3Match = h3Pattern.exec(entityTypesContent)) !== null) {
    h3Matches.push({ name: h3Match[1]!.trim(), index: h3Match.index });
  }

  for (let i = 0; i < h3Matches.length; i++) {
    const current = h3Matches[i]!;
    const nextStart = i + 1 < h3Matches.length ? h3Matches[i + 1]!.index : entityTypesContent.length;
    const sectionContent = entityTypesContent.slice(current.index, nextStart);

    const classificationProperties = parseClassificationProperties(sectionContent);

    sections.push({
      entityType: current.name,
      classificationProperties,
    });
  }

  return sections;
}

/**
 * Within an entity type section, find "Recommended `X` values" tables
 * and extract the property name and listed values.
 */
function parseClassificationProperties(sectionContent: string): ClassificationProperty[] {
  const properties: ClassificationProperty[] = [];

  // Match patterns like: **Recommended `equipmentType` values:**
  const recommendedPattern = /\*\*Recommended `([^`]+)` values[^*]*\*\*/g;
  let match;

  while ((match = recommendedPattern.exec(sectionContent)) !== null) {
    const propertyName = match[1]!;
    const afterHeading = sectionContent.slice(match.index + match[0].length);

    // Parse the table that follows — look for | Value | rows
    const values: string[] = [];
    const tableLines = afterHeading.split('\n');

    let inTable = false;
    for (const line of tableLines) {
      const trimmed = line.trim();

      // Start of table
      if (trimmed.startsWith('|') && trimmed.includes('Value')) {
        inTable = true;
        continue;
      }

      // Separator row
      if (inTable && /^\|[\s-|]+\|$/.test(trimmed)) {
        continue;
      }

      // Data row
      if (inTable && trimmed.startsWith('|')) {
        const cells = trimmed.split('|').map(c => c.trim()).filter(c => c.length > 0);
        if (cells.length > 0) {
          // First cell is the value, strip backticks
          const value = cells[0]!.replace(/`/g, '');
          if (value.length > 0) {
            values.push(value);
          }
        }
        continue;
      }

      // End of table — any non-table line after we've started
      if (inTable && !trimmed.startsWith('|')) {
        break;
      }
    }

    if (values.length > 0) {
      properties.push({ name: propertyName, recommendedValues: values });
    }
  }

  return properties;
}
