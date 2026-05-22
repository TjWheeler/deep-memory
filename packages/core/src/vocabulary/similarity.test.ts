import { describe, it, expect } from 'vitest';
import { jaroSimilarity, jaroWinklerSimilarity, normalizeTypeName, toScreamingSnakeCase } from './similarity.js';

describe('jaroSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(jaroSimilarity('person', 'person')).toBe(1);
  });

  it('returns 0 for completely different strings', () => {
    expect(jaroSimilarity('abc', 'xyz')).toBe(0);
  });

  it('returns 0 when either string is empty', () => {
    expect(jaroSimilarity('', 'abc')).toBe(0);
    expect(jaroSimilarity('abc', '')).toBe(0);
    // Two empty strings are considered identical
    expect(jaroSimilarity('', '')).toBe(1);
  });

  it('returns high similarity for similar strings', () => {
    const sim = jaroSimilarity('person', 'persons');
    expect(sim).toBeGreaterThan(0.9);
  });

  it('handles single character strings', () => {
    expect(jaroSimilarity('a', 'a')).toBe(1);
    expect(jaroSimilarity('a', 'b')).toBe(0);
  });
});

describe('jaroWinklerSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(jaroWinklerSimilarity('clause', 'clause')).toBe(1);
  });

  it('boosts score for common prefixes', () => {
    const jaro = jaroSimilarity('component', 'component_of');
    const winkler = jaroWinklerSimilarity('component', 'component_of');
    expect(winkler).toBeGreaterThanOrEqual(jaro);
  });

  it('returns higher similarity for "person" vs "persons" than "person" vs "nosrep"', () => {
    const simClose = jaroWinklerSimilarity('person', 'persons');
    const simReverse = jaroWinklerSimilarity('person', 'nosrep');
    expect(simClose).toBeGreaterThan(simReverse);
  });

  it('detects near-duplicate type names', () => {
    // These should be caught as potential duplicates
    expect(jaroWinklerSimilarity('works_on', 'works_for')).toBeGreaterThan(0.8);
    expect(jaroWinklerSimilarity('component', 'componenet')).toBeGreaterThan(0.8); // typo
  });

  it('distinguishes genuinely different types', () => {
    expect(jaroWinklerSimilarity('person', 'clause')).toBeLessThan(0.7);
    expect(jaroWinklerSimilarity('part', 'jurisdiction')).toBeLessThan(0.6);
  });
});

describe('normalizeTypeName', () => {
  it('lowercases', () => {
    expect(normalizeTypeName('Person')).toBe('person');
  });

  it('replaces hyphens with underscores', () => {
    expect(normalizeTypeName('component-of')).toBe('component_of');
  });

  it('replaces spaces with underscores', () => {
    expect(normalizeTypeName('works on')).toBe('works_on');
  });

  it('replaces dots with underscores', () => {
    expect(normalizeTypeName('entity.type')).toBe('entity_type');
  });

  it('removes non-alphanumeric characters', () => {
    expect(normalizeTypeName('works_on!')).toBe('works_on');
  });

  it('trims whitespace', () => {
    expect(normalizeTypeName('  person  ')).toBe('person');
  });

  it('collapses multiple separators', () => {
    expect(normalizeTypeName('works--on')).toBe('works_on');
    expect(normalizeTypeName('works  on')).toBe('works_on');
  });
});

describe('toScreamingSnakeCase', () => {
  it('converts snake_case', () => {
    expect(toScreamingSnakeCase('works_on')).toBe('WORKS_ON');
  });

  it('converts camelCase', () => {
    expect(toScreamingSnakeCase('worksOn')).toBe('WORKS_ON');
    expect(toScreamingSnakeCase('componentOf')).toBe('COMPONENT_OF');
  });

  it('converts PascalCase', () => {
    expect(toScreamingSnakeCase('WorksOn')).toBe('WORKS_ON');
  });

  it('converts kebab-case', () => {
    expect(toScreamingSnakeCase('works-on')).toBe('WORKS_ON');
  });

  it('converts space-separated', () => {
    expect(toScreamingSnakeCase('Works On')).toBe('WORKS_ON');
  });

  it('converts dot.case', () => {
    expect(toScreamingSnakeCase('works.on')).toBe('WORKS_ON');
  });

  it('is idempotent for SCREAMING_SNAKE_CASE', () => {
    expect(toScreamingSnakeCase('WORKS_ON')).toBe('WORKS_ON');
    expect(toScreamingSnakeCase('COMPONENT_OF')).toBe('COMPONENT_OF');
  });

  it('handles single words', () => {
    expect(toScreamingSnakeCase('knows')).toBe('KNOWS');
    expect(toScreamingSnakeCase('KNOWS')).toBe('KNOWS');
    expect(toScreamingSnakeCase('Knows')).toBe('KNOWS');
  });

  it('handles acronyms', () => {
    expect(toScreamingSnakeCase('HTMLParser')).toBe('HTML_PARSER');
  });

  it('trims whitespace', () => {
    expect(toScreamingSnakeCase('  works_on  ')).toBe('WORKS_ON');
  });

  it('collapses multiple separators', () => {
    expect(toScreamingSnakeCase('works--on')).toBe('WORKS_ON');
    expect(toScreamingSnakeCase('works__on')).toBe('WORKS_ON');
  });
});
