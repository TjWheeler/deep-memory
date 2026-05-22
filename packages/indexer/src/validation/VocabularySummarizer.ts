/**
 * Parses a vocabulary markdown document and produces a concise summary
 * of entity types with their classification properties and recommended values.
 *
 * This summary is domain-agnostic — it works with any vocabulary that follows
 * the standard format (entity type headings, property tables, and
 * "Recommended `X` values" sections).
 *
 * The output is designed for the full validation prompt, where the validator
 * needs to understand that classification properties use standardized vocabulary
 * values rather than verbatim source text.
 */
export function summarizeVocabularyForValidation(vocabularyMarkdown: string): string {
  const entitySections = parseEntitySections(vocabularyMarkdown);

  if (entitySections.length === 0) {
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

  for (const section of entitySections) {
    if (section.classificationProperties.length === 0) continue;

    lines.push(`### ${section.entityType}`);
    for (const prop of section.classificationProperties) {
      const values = prop.recommendedValues.join(', ');
      lines.push(`- \`${prop.name}\`: ${values}`);
    }
    lines.push('');
  }

  return lines.join('\n');
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
