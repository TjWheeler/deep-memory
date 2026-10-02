import { describe, it, expect } from 'vitest';
import {
  createEmptyVocabulary,
  createEntityTypeDefinition,
  createRelationshipTypeDefinition,
  buildVocabulary,
  incrementVersion,
  compareVersions,
  isValidVocabularyVersion,
} from './VocabularySchema.js';
import { InvalidInputError } from '../core/errors.js';

describe('createEmptyVocabulary', () => {
  it('creates a vocabulary with version 0.0.0', () => {
    const vocab = createEmptyVocabulary('system');
    expect(vocab.version).toBe('0.0.0');
    expect(vocab.entityTypes).toEqual([]);
    expect(vocab.relationshipTypes).toEqual([]);
    expect(vocab.modifiedBy).toBe('system');
    expect(vocab.lastModified).toBeTruthy();
  });
});

describe('createEntityTypeDefinition', () => {
  it('creates a well-formed entity type from input', () => {
    const def = createEntityTypeDefinition(
      {
        type: 'person',
        description: 'A human person',
        properties: [{ name: 'role', type: 'string', required: false }],
      },
      'admin',
    );

    expect(def.type).toBe('person');
    expect(def.description).toBe('A human person');
    expect(def.version).toBe('1.0.0');
    expect(def.properties).toHaveLength(1);
    expect(def.createdBy).toBe('admin');
    expect(def.modifiedBy).toBe('admin');
    expect(def.createdAt).toBeTruthy();
    expect(def.modifiedAt).toBeTruthy();
  });

  it('defaults to empty properties array', () => {
    const def = createEntityTypeDefinition(
      { type: 'note', description: 'A note' },
      'admin',
    );
    expect(def.properties).toEqual([]);
  });
});

describe('createRelationshipTypeDefinition', () => {
  it('creates a well-formed relationship type from input', () => {
    const def = createRelationshipTypeDefinition(
      {
        type: 'works_on',
        description: 'Person works on a project',
        allowedSourceTypes: ['person'],
        allowedTargetTypes: ['project'],
      },
      'admin',
    );

    expect(def.type).toBe('WORKS_ON');
    expect(def.allowedSourceTypes).toEqual(['person']);
    expect(def.allowedTargetTypes).toEqual(['project']);
    expect(def.bidirectional).toBe(false);
    expect(def.version).toBe('1.0.0');
  });

  it('respects bidirectional flag', () => {
    const def = createRelationshipTypeDefinition(
      {
        type: 'colleague',
        description: 'Colleagues',
        allowedSourceTypes: ['person'],
        allowedTargetTypes: ['person'],
        bidirectional: true,
      },
      'admin',
    );
    expect(def.bidirectional).toBe(true);
  });
});

describe('buildVocabulary', () => {
  it('builds a full vocabulary from input', () => {
    const vocab = buildVocabulary(
      {
        entityTypes: [
          { type: 'person', description: 'A person' },
          { type: 'project', description: 'A project' },
        ],
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

    expect(vocab.version).toBe('1.0.0');
    expect(vocab.entityTypes).toHaveLength(2);
    expect(vocab.relationshipTypes).toHaveLength(1);
    expect(vocab.entityTypes[0]!.type).toBe('person');
    expect(vocab.relationshipTypes[0]!.type).toBe('WORKS_ON');
  });

  it('handles empty input', () => {
    const vocab = buildVocabulary({}, 'admin');
    expect(vocab.entityTypes).toEqual([]);
    expect(vocab.relationshipTypes).toEqual([]);
  });
});

describe('incrementVersion', () => {
  it('increments patch by default', () => {
    expect(incrementVersion('1.2.3')).toBe('1.2.4');
  });

  it('increments minor', () => {
    expect(incrementVersion('1.2.3', 'minor')).toBe('1.3.0');
  });

  it('increments major', () => {
    expect(incrementVersion('1.2.3', 'major')).toBe('2.0.0');
  });

  it('handles 0.0.0', () => {
    expect(incrementVersion('0.0.0', 'minor')).toBe('0.1.0');
  });

  it('treats missing trailing components as 0', () => {
    expect(incrementVersion('1.2', 'patch')).toBe('1.2.1');
  });

  it.each(['1.x.0', '1.-1.0', '1.2.3-beta', '', '1..0', ' 1.0.0', '1.0.9007199254740993'])(
    'throws InvalidInputError for malformed version %j',
    (version) => {
      expect(() => incrementVersion(version, 'minor')).toThrow(InvalidInputError);
    },
  );
});

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });
});

describe('isValidVocabularyVersion', () => {
  it('accepts major.minor.patch', () => {
    expect(isValidVocabularyVersion('0.0.0')).toBe(true);
    expect(isValidVocabularyVersion('12.4.100')).toBe(true);
  });

  it.each(['1.0', '1.0.0.0', '1.x.0', 'v1.0.0', '1.0.0-beta', ''])('rejects %j', (version) => {
    expect(isValidVocabularyVersion(version)).toBe(false);
  });
});
