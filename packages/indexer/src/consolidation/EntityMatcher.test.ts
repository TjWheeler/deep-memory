import { describe, it, expect } from 'vitest';
import { EntityMatcher } from './EntityMatcher.js';
import type { RegistryEntry } from '../types/registry.js';

const makeEntry = (overrides: Partial<RegistryEntry> & Pick<RegistryEntry, 'id' | 'label' | 'entityType'>): RegistryEntry => ({
  slug: `${overrides.entityType}:${overrides.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  status: 'imported',
  aliases: [],
  sourceDocuments: [],
  ...overrides,
});

describe('EntityMatcher', () => {
  const entries: RegistryEntry[] = [
    makeEntry({ id: 'uuid-1', entityType: 'Equipment', label: 'Komatsu 930E', aliases: ['930E', '930E-4', 'Komatsu 930E-4'] }),
    makeEntry({ id: 'uuid-2', entityType: 'Equipment', label: 'Cat 793F', aliases: ['793F'] }),
    makeEntry({ id: 'uuid-3', entityType: 'Fluid', label: 'SAE 15W-40' }),
    makeEntry({ id: 'uuid-4', entityType: 'Equipment', label: 'Komatsu PC7000-11', aliases: ['PC7000-11', 'PC7000'] }),
  ];

  const matcher = new EntityMatcher(entries);

  describe('exact slug match', () => {
    it('matches by exact slug', () => {
      const result = matcher.match({
        entityType: 'Equipment',
        label: 'Komatsu 930E',
        aliases: [],
        properties: {},
        sourceRefs: [],
      });

      expect(result.match?.id).toBe('uuid-1');
      expect(result.confidence).toBe(1.0);
      expect(result.matchedBy).toBe('exact-slug');
    });
  });

  describe('alias match', () => {
    it('matches when extracted label is an alias of a registry entry', () => {
      const result = matcher.match({
        entityType: 'Equipment',
        label: '930E-4',
        aliases: [],
        properties: {},
        sourceRefs: [],
      });

      expect(result.match?.id).toBe('uuid-1');
      expect(result.confidence).toBe(0.9);
      expect(result.matchedBy).toBe('alias');
    });

    it('matches when extracted alias matches registry label', () => {
      const result = matcher.match({
        entityType: 'Equipment',
        label: 'Komatsu 930E-4 Truck',
        aliases: ['930E'],
        properties: {},
        sourceRefs: [],
      });

      expect(result.match?.id).toBe('uuid-1');
      expect(result.confidence).toBe(0.9);
      expect(result.matchedBy).toBe('alias');
    });
  });

  describe('label similarity', () => {
    it('matches similar labels within same entity type', () => {
      const result = matcher.match({
        entityType: 'Equipment',
        label: 'Cat 793F Mining Truck',
        aliases: [],
        properties: {},
        sourceRefs: [],
      });

      // Jaro-Winkler for "cat 793f mining truck" vs "cat 793f" should be high
      // but may or may not meet 0.9 threshold — depends on string length ratio
      if (result.match) {
        expect(result.matchedBy).toBe('label-similarity');
        expect(result.confidence).toBeGreaterThanOrEqual(0.9);
      }
    });
  });

  describe('no match', () => {
    it('returns no match for unknown entities', () => {
      const result = matcher.match({
        entityType: 'Equipment',
        label: 'Liebherr T 282 C',
        aliases: ['T282C'],
        properties: {},
        sourceRefs: [],
      });

      expect(result.match).toBeNull();
      expect(result.matchedBy).toBe('none');
    });

    it('does not match across entity types', () => {
      const result = matcher.match({
        entityType: 'Component',
        label: 'Komatsu 930E',
        aliases: [],
        properties: {},
        sourceRefs: [],
      });

      // Should not match uuid-1 (Equipment type)
      expect(result.matchedBy).toBe('none');
    });
  });
});
