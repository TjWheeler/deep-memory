import { describe, it, expect } from 'vitest';
import {
  DeepMemoryError,
  DuplicateEntityError,
  DuplicateRelationshipError,
  DuplicateRepositoryError,
  SlugConflictError,
} from './errors.js';

describe('duplicate errors', () => {
  it('keep the native error as cause when one is given', () => {
    const native = new Error('unique constraint violated');
    expect(new DuplicateEntityError('e1', { cause: native }).cause).toBe(native);
    expect(new DuplicateRelationshipError('r1', { cause: native }).cause).toBe(native);
    expect(new DuplicateRepositoryError('repo', { cause: native }).cause).toBe(native);
  });

  it('leave cause undefined when none is given', () => {
    expect(new DuplicateEntityError('e1').cause).toBeUndefined();
  });
});

describe('SlugConflictError', () => {
  it('carries the slug, entity type, label, code and cause', () => {
    const native = new Error('slug taken');
    const err = new SlugConflictError(
      'person:alex',
      { entityType: 'person', label: 'Alex' },
      { cause: native },
    );

    expect(err).toBeInstanceOf(DeepMemoryError);
    expect(err.name).toBe('SlugConflictError');
    expect(err.code).toBe('SLUG_CONFLICT');
    expect(err.slug).toBe('person:alex');
    expect(err.entityType).toBe('person');
    expect(err.label).toBe('Alex');
    expect(err.cause).toBe(native);
    expect(err.message).toBe(
      'Slug "person:alex" for person "Alex" is already taken by another entity in this repository',
    );
    expect(err.suggestion).toMatch(/Retry the write/);
  });

  it('omits the type and label from the message when they are unknown', () => {
    const err = new SlugConflictError('person:alex');
    expect(err.message).toBe('Slug "person:alex" is already taken by another entity in this repository');
    expect(err.entityType).toBeUndefined();
    expect(err.label).toBeUndefined();
  });
});
