import { describe, it, expect } from 'vitest';
import { summarizeVocabularyForValidation } from './VocabularySummarizer.js';

// A closed-enum-bearing vocabulary in a neutral domain — no assumptions about any
// particular subject area are baked into the summarizer; it reflects whatever the
// vocabulary declares.
const VOCABULARY = `
# Test Vocabulary

## Entity Types

### Widget

A physical widget in the catalog.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`code\` | string | Yes | Catalog code |
| \`grade\` | enum | Yes | Quality grade |
| \`notes\` | string | No | Freeform notes |

**Allowed \`grade\` values:**

| Value | Description |
|-------|-------------|
| \`alpha\` | Top grade |
| \`beta\` | Mid grade |

**Recommended \`code\` values:**

| Value | Description |
|-------|-------------|
| \`W-1\` | First widget |

### Gadget

A gadget assembled from widgets.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`name\` | string | Yes | Gadget name |

## Relationship Types

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| \`CONTAINS\` | Gadget contains a widget | Gadget → Widget | No |
| \`RELATED_TO\` | Generic link | Widget → Widget, Gadget | No |

#### Properties for \`CONTAINS\`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`quantity\` | number | Yes | How many widgets |
`;

describe('summarizeVocabularyForValidation', () => {
  it('lists entity types with their required properties, expanding closed-enum values', () => {
    const summary = summarizeVocabularyForValidation(VOCABULARY);

    expect(summary).toContain('## Vocabulary Types');
    expect(summary).toContain('### Entity Types');
    expect(summary).toContain('A physical widget in the catalog.');

    const widgetLine = summary.split('\n').find(l => l.includes('`Widget`'));
    expect(widgetLine).toBeDefined();
    // Both required properties are listed; the optional one is not.
    expect(widgetLine).toContain('Required:');
    expect(widgetLine).toContain('`code`');
    expect(widgetLine).toContain('`grade`');
    expect(widgetLine).not.toContain('`notes`');
    // A required closed enum surfaces its allowed set so a proposed create can be valid.
    expect(widgetLine).toContain('one of: alpha, beta');

    const gadgetLine = summary.split('\n').find(l => l.includes('`Gadget`'));
    expect(gadgetLine).toContain('Required: `name`');
  });

  it('lists relationship types with their endpoint types and required properties', () => {
    const summary = summarizeVocabularyForValidation(VOCABULARY);

    expect(summary).toContain('### Relationship Types');

    const containsLine = summary.split('\n').find(l => l.includes('`CONTAINS`'));
    expect(containsLine).toContain('Gadget → Widget');
    expect(containsLine).toContain('Required: `quantity`');

    // Multiple allowed targets are rendered together.
    const relatedLine = summary.split('\n').find(l => l.includes('`RELATED_TO`'));
    expect(relatedLine).toContain('Widget → Widget | Gadget');
  });

  it('still emits the classification-properties section for open recommended values', () => {
    const summary = summarizeVocabularyForValidation(VOCABULARY);

    expect(summary).toContain('## Vocabulary Classification Properties');
    // `code` has a Recommended (open) table, so it appears as a classification property.
    expect(summary).toContain('`code`: W-1');
  });

  it('returns an empty string for a vocabulary with no recognizable sections', () => {
    expect(summarizeVocabularyForValidation('# Nothing here\n\nJust prose.')).toBe('');
  });
});
