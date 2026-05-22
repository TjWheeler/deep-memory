import { describe, it, expect } from 'vitest';
import { ProgressiveContext } from './ProgressiveContext.js';
import type { ExtractedEntity, ExtractedRelationship } from '../types/extraction.js';

function makeEntity(type: string, label: string, summary?: string): ExtractedEntity {
  return {
    entityType: type,
    label,
    summary,
    properties: {},
    aliases: [],
    sourceRefs: [],
  };
}

function makeRel(type: string, source: string, target: string): ExtractedRelationship {
  return {
    type,
    sourceLabel: source,
    targetLabel: target,
    properties: {},
    sourceRefs: [],
  };
}

describe('ProgressiveContext', () => {
  it('returns empty string when no context accumulated', () => {
    const ctx = new ProgressiveContext();
    expect(ctx.toPromptSection(0)).toBe('');
  });

  it('serializes entities from one chapter', () => {
    const ctx = new ProgressiveContext();
    ctx.addChapterResults(0, [
      makeEntity('Equipment', 'Cat 325F', 'Hydraulic excavator'),
      makeEntity('Manufacturer', 'Caterpillar', 'US manufacturer'),
    ], []);

    const section = ctx.toPromptSection(1);
    expect(section).toContain('[Equipment] "Cat 325F"');
    expect(section).toContain('[Manufacturer] "Caterpillar"');
    expect(section).toContain('Hydraulic excavator');
  });

  it('serializes relationships', () => {
    const ctx = new ProgressiveContext();
    ctx.addChapterResults(0, [
      makeEntity('Equipment', 'Cat 325F'),
    ], [
      makeRel('MANUFACTURED_BY', 'Cat 325F', 'Caterpillar'),
    ]);

    const section = ctx.toPromptSection(1);
    expect(section).toContain('MANUFACTURED_BY: "Cat 325F" → "Caterpillar"');
  });

  it('deduplicates entities across chapters by type+label', () => {
    const ctx = new ProgressiveContext();
    ctx.addChapterResults(0, [
      makeEntity('Equipment', 'Cat 325F', 'Short summary'),
    ], []);
    ctx.addChapterResults(1, [
      makeEntity('Equipment', 'Cat 325F', 'A much longer and more detailed summary'),
    ], []);

    expect(ctx.entityCount).toBe(1);
    const section = ctx.toPromptSection(2);
    // Should keep the longer summary
    expect(section).toContain('A much longer and more detailed summary');
  });

  it('applies recency window', () => {
    const ctx = new ProgressiveContext(2); // only retain 2 chapters
    ctx.addChapterResults(0, [makeEntity('Equipment', 'Old Entity')], []);
    ctx.addChapterResults(1, [makeEntity('Equipment', 'Middle Entity')], []);
    ctx.addChapterResults(2, [makeEntity('Equipment', 'New Entity')], []);

    // At chapter 3, window is [1, 2] — chapter 0 should be dropped
    const section = ctx.toPromptSection(3);
    expect(section).not.toContain('Old Entity');
    expect(section).toContain('Middle Entity');
    expect(section).toContain('New Entity');
  });

  it('retains entities seen in multiple chapters beyond recency window', () => {
    const ctx = new ProgressiveContext(2);
    ctx.addChapterResults(0, [makeEntity('Equipment', 'Reused Entity')], []);
    ctx.addChapterResults(1, [makeEntity('Equipment', 'Reused Entity')], []); // bumps lastSeen to 1
    ctx.addChapterResults(2, [makeEntity('Equipment', 'New Only')], []);

    // At chapter 3, window is [1, 2] — "Reused Entity" was bumped to chapter 1, still in window
    const section = ctx.toPromptSection(3);
    expect(section).toContain('Reused Entity');
  });

  it('truncates long summaries', () => {
    const ctx = new ProgressiveContext();
    const longSummary = 'A'.repeat(200);
    ctx.addChapterResults(0, [makeEntity('Equipment', 'Test', longSummary)], []);

    const section = ctx.toPromptSection(1);
    // Summary should be truncated with ...
    expect(section).toContain('...');
    expect(section.length).toBeLessThan(longSummary.length + 100);
  });
});
