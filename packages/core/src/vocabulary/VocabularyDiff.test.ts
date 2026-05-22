import { describe, it, expect } from 'vitest';
import { diffVocabularies } from './VocabularyDiff.js';
import { buildVocabulary, createEntityTypeDefinition } from './VocabularySchema.js';

describe('diffVocabularies', () => {
  it('detects no changes between identical vocabularies', () => {
    const vocab = buildVocabulary(
      { entityTypes: [{ type: 'person', description: 'A person' }] },
      'admin',
    );
    const result = diffVocabularies(vocab, vocab);
    expect(result.hasChanges).toBe(false);
    expect(result.changes).toHaveLength(0);
  });

  it('detects added entity type', () => {
    const from = buildVocabulary(
      { entityTypes: [{ type: 'person', description: 'A person' }] },
      'admin',
    );
    const to = buildVocabulary(
      {
        entityTypes: [
          { type: 'person', description: 'A person' },
          { type: 'project', description: 'A project' },
        ],
      },
      'admin',
    );
    const result = diffVocabularies(from, to);
    expect(result.hasChanges).toBe(true);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]!.changeType).toBe('added');
    expect(result.changes[0]!.category).toBe('entity_type');
    expect(result.changes[0]!.typeName).toBe('project');
  });

  it('detects removed entity type', () => {
    const from = buildVocabulary(
      {
        entityTypes: [
          { type: 'person', description: 'A person' },
          { type: 'project', description: 'A project' },
        ],
      },
      'admin',
    );
    const to = buildVocabulary(
      { entityTypes: [{ type: 'person', description: 'A person' }] },
      'admin',
    );
    const result = diffVocabularies(from, to);
    expect(result.hasChanges).toBe(true);
    const removed = result.changes.find((c) => c.changeType === 'removed');
    expect(removed).toBeDefined();
    expect(removed!.typeName).toBe('project');
  });

  it('detects modified entity type (description change)', () => {
    const from = buildVocabulary(
      { entityTypes: [{ type: 'person', description: 'A person' }] },
      'admin',
    );
    const to = buildVocabulary(
      { entityTypes: [{ type: 'person', description: 'A human being' }] },
      'admin',
    );
    const result = diffVocabularies(from, to);
    expect(result.hasChanges).toBe(true);
    const modified = result.changes.find((c) => c.changeType === 'modified');
    expect(modified).toBeDefined();
    expect(modified!.details).toContain('description changed');
  });

  it('detects modified entity type (property added)', () => {
    const from = buildVocabulary(
      { entityTypes: [{ type: 'person', description: 'A person' }] },
      'admin',
    );
    const to = buildVocabulary(
      {
        entityTypes: [
          {
            type: 'person',
            description: 'A person',
            properties: [{ name: 'role', type: 'string', required: true }],
          },
        ],
      },
      'admin',
    );
    const result = diffVocabularies(from, to);
    expect(result.hasChanges).toBe(true);
    const modified = result.changes.find((c) => c.changeType === 'modified');
    expect(modified!.details).toContain('property "role" added');
  });

  it('detects added relationship type', () => {
    const from = buildVocabulary({ entityTypes: [] }, 'admin');
    const to = buildVocabulary(
      {
        relationshipTypes: [
          {
            type: 'works_on',
            description: 'Works on',
            allowedSourceTypes: ['person'],
            allowedTargetTypes: ['project'],
          },
        ],
      },
      'admin',
    );
    const result = diffVocabularies(from, to);
    expect(result.hasChanges).toBe(true);
    expect(result.changes[0]!.category).toBe('relationship_type');
    expect(result.changes[0]!.changeType).toBe('added');
  });

  it('detects modified relationship type (allowedSourceTypes change)', () => {
    const from = buildVocabulary(
      {
        relationshipTypes: [
          {
            type: 'works_on',
            description: 'Works on',
            allowedSourceTypes: ['person'],
            allowedTargetTypes: ['project'],
          },
        ],
      },
      'admin',
    );
    const to = buildVocabulary(
      {
        relationshipTypes: [
          {
            type: 'works_on',
            description: 'Works on',
            allowedSourceTypes: ['person', 'team'],
            allowedTargetTypes: ['project'],
          },
        ],
      },
      'admin',
    );
    const result = diffVocabularies(from, to);
    expect(result.hasChanges).toBe(true);
    const modified = result.changes.find((c) => c.changeType === 'modified');
    expect(modified!.details).toContain('allowedSourceTypes');
    expect(modified!.details).toContain('team');
  });

  it('includes from and to versions', () => {
    const from = buildVocabulary({}, 'admin');
    const to = { ...buildVocabulary({}, 'admin'), version: '2.0.0' };
    const result = diffVocabularies(from, to);
    expect(result.fromVersion).toBe('1.0.0');
    expect(result.toVersion).toBe('2.0.0');
  });
});
