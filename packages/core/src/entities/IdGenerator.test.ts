import { describe, it, expect } from 'vitest';
import {
  generateSlug,
  generateUniqueSlug,
  generateEntityId,
  generateRelationshipId,
} from './IdGenerator.js';

describe('generateSlug', () => {
  it('creates type:slug format', () => {
    expect(generateSlug('person', 'John Smith')).toBe('person:john-smith');
  });

  it('handles special characters', () => {
    expect(generateSlug('clause', 'Mutual NDA — Tech')).toBe('clause:mutual-nda-tech');
  });

  it('handles empty label', () => {
    expect(generateSlug('note', '')).toBe('note:unnamed');
  });

  it('is deterministic', () => {
    const slug1 = generateSlug('person', 'John Smith');
    const slug2 = generateSlug('person', 'John Smith');
    expect(slug1).toBe(slug2);
  });

  it('handles numbers in labels', () => {
    expect(generateSlug('part', 'Part 123-A')).toBe('part:part-123-a');
  });
});

describe('generateUniqueSlug', () => {
  it('returns base slug when no collision', async () => {
    const slug = await generateUniqueSlug('person', 'Tim', async () => false);
    expect(slug).toBe('person:tim');
  });

  it('appends suffix on collision', async () => {
    const taken = new Set(['person:tim']);
    const slug = await generateUniqueSlug('person', 'Tim', async (candidate) =>
      taken.has(candidate),
    );
    expect(slug).toBe('person:tim-2');
  });

  it('increments suffix until unique', async () => {
    const taken = new Set(['person:tim', 'person:tim-2', 'person:tim-3']);
    const slug = await generateUniqueSlug('person', 'Tim', async (candidate) =>
      taken.has(candidate),
    );
    expect(slug).toBe('person:tim-4');
  });
});

describe('generateEntityId', () => {
  it('returns a UUID string', () => {
    const id = generateEntityId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('returns unique values', () => {
    const id1 = generateEntityId();
    const id2 = generateEntityId();
    expect(id1).not.toBe(id2);
  });
});

describe('generateRelationshipId', () => {
  it('returns a UUID string', () => {
    const id = generateRelationshipId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('returns unique values', () => {
    const id1 = generateRelationshipId();
    const id2 = generateRelationshipId();
    expect(id1).not.toBe(id2);
  });
});
