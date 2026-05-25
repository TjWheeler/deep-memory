import { describe, it, expect } from 'vitest';
import { GremlinCompiler } from './GremlinCompiler.js';
import type { TraversalSpec } from '../../types/traversal.js';
import type { MemoryVocabulary } from '../../types/vocabulary.js';

const compiler = new GremlinCompiler();

const emptyVocab: MemoryVocabulary = {
  version: '1.0.0',
  lastModified: '',
  modifiedBy: '',
  entityTypes: [],
  relationshipTypes: [],
};

describe('GremlinCompiler', () => {
  it('reports language as gremlin', () => {
    expect(compiler.language).toBe('gremlin');
  });

  it('compiles a simple single-hop traversal', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'entity-1' },
      steps: [{ direction: 'out', relationshipTypes: ['HAS_COMPONENT'] }],
      returnMode: 'terminal',
    };
    const result = compiler.compile(spec, emptyVocab);

    expect(result.query).toContain('g.V()');
    expect(result.query).toContain(".has('id',");
    expect(result.query).toContain('.out(');
    expect(result.query).toContain('.dedup()');
    expect(result.query).toContain('.range(');
    expect(result.query).toContain('.valueMap(true)');
    expect(Object.values(result.params)).toContain('entity-1');
    expect(Object.values(result.params)).toContain('HAS_COMPONENT');
  });

  it('compiles an inbound traversal', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'entity-1' },
      steps: [{ direction: 'in', relationshipTypes: ['BELONGS_TO'] }],
      returnMode: 'terminal',
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).toContain('.in(');
  });

  it('compiles a both-direction traversal', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'entity-1' },
      steps: [{ direction: 'both' }],
      returnMode: 'terminal',
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).toContain('.both()');
  });

  it('compiles multi-hop traversal', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'equipment-1' },
      steps: [
        { direction: 'out', relationshipTypes: ['HAS_COMPONENT'] },
        { direction: 'out', relationshipTypes: ['REQUIRES_FLUID'] },
      ],
      returnMode: 'terminal',
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).toContain('.out(');
    // Should have two out() calls
    const outCount = (result.query.match(/\.out\(/g) ?? []).length;
    expect(outCount).toBe(2);
  });

  it('compiles entity type filters', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [{ direction: 'out', entityTypes: ['Fluid'] }],
      returnMode: 'terminal',
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).toContain("'entityType'");
    expect(result.query).toContain('within(');
    expect(Object.values(result.params)).toContain('Fluid');
  });

  it('compiles relationship property filters using edge traversal', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [{
        direction: 'out',
        relationshipTypes: ['REQUIRES_FLUID'],
        relationshipFilter: [{ key: 'passCount', operator: 'gte', value: 3 }],
      }],
      returnMode: 'terminal',
    };
    const result = compiler.compile(spec, emptyVocab);
    // Should use edge traversal pattern
    expect(result.query).toContain('.outE(');
    expect(result.query).toContain('.inV()');
    expect(result.query).toContain('gte(');
  });

  it('compiles repeat steps', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [{ direction: 'out', relationshipTypes: ['CONTAINS'], repeat: { maxDepth: 5 } }],
      returnMode: 'terminal',
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).toContain('.repeat(');
    expect(result.query).toContain('.times(');
    expect(result.query).toContain('.emit()');
  });

  it('compiles path return mode', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [{ direction: 'out' }],
      returnMode: 'path',
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).toContain('.path()');
  });

  it('omits dedup when dedup is false', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [{ direction: 'out' }],
      returnMode: 'terminal',
      dedup: false,
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).not.toContain('.dedup()');
  });

  it('uses parameterized values (no direct interpolation)', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'some-id' },
      steps: [{
        direction: 'out',
        entityFilter: [{ key: 'name', operator: 'eq', value: "'; DROP TABLE" }],
      }],
      returnMode: 'terminal',
    };
    const result = compiler.compile(spec, emptyVocab);
    // The dangerous string should be in params, not in the query
    expect(result.query).not.toContain('DROP TABLE');
    expect(Object.values(result.params)).toContain("'; DROP TABLE");
  });

  it('handles pagination with offset and limit', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [{ direction: 'out' }],
      returnMode: 'terminal',
      limit: 20,
      offset: 10,
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).toContain('.range(');
    expect(result.params['_limit']).toBe(20);
    expect(result.params['_offset']).toBe(10);
  });

  it('compiles start by entityType', () => {
    const spec: TraversalSpec = {
      start: { entityType: 'Equipment' },
      steps: [{ direction: 'out' }],
      returnMode: 'terminal',
      limit: 50,
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).toContain("'entityType'");
    expect(Object.values(result.params)).toContain('Equipment');
  });

  it('caps estimatedFanOut at 10000', () => {
    const spec: TraversalSpec = {
      start: { entityType: 'Equipment' },
      steps: [
        { direction: 'out', repeat: { maxDepth: 10 } },
        { direction: 'out', repeat: { maxDepth: 10 } },
      ],
      returnMode: 'terminal',
      limit: 50,
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.estimatedFanOut).toBeLessThanOrEqual(10000);
  });

  // ─── 'all' mode — union + server-side dedup (Phase 2/3 revised) ──

  it("compiles 'all' mode as a union of every depth's edges and vertices", () => {
    const spec: TraversalSpec = {
      start: { entityType: 'Identity' },
      steps: [
        { direction: 'out', relationshipTypes: ['IS_IDENTITY_FOR'] },
        { direction: 'out', relationshipTypes: ['WORKS_AT'] },
      ],
      returnMode: 'all',
      dedup: false,
    };
    const result = compiler.compile(spec, emptyVocab);

    // Each branch is an anonymous traversal rooted with __.
    expect(result.query).toContain('.union(');
    expect(result.query).toContain('__.identity()');
    expect(result.query).toMatch(/__\.outE\(p\d+\)/);
    expect(result.query).toMatch(/__\.outE\(p\d+\)\.inV\(\)/);
    expect(result.query).toMatch(/__\.outE\(p\d+\)\.inV\(\)\.outE\(p\d+\)/);
    expect(result.query).toMatch(/__\.outE\(p\d+\)\.inV\(\)\.outE\(p\d+\)\.inV\(\)/);

    // 'all' is inherently deduped server-side, spec.dedup is ignored.
    expect(result.query).toContain('.dedup()');

    // Flat valueMap projection — not path().by(...).
    expect(result.query).toContain('.valueMap(true)');
    expect(result.query).not.toContain('.path()');
  });

  it("compiles 'all' mode with .dedup() even when spec.dedup is false", () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [{ direction: 'out', relationshipTypes: ['HAS_COMPONENT'] }],
      returnMode: 'all',
      dedup: false,
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).toContain('.dedup()');
  });

  it("throws on 'all' mode with repeat steps (documented limitation)", () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [{ direction: 'out', relationshipTypes: ['CONTAINS'], repeat: { maxDepth: 3 } }],
      returnMode: 'all',
    };
    expect(() => compiler.compile(spec, emptyVocab)).toThrow(/repeat/);
  });

  // ─── 'path' mode — edge-explicit + path().by(valueMap(true)), no dedup ──

  it("compiles 'path' mode with edge-explicit emission and .path().by(valueMap(true))", () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [
        { direction: 'out', relationshipTypes: ['IS_IDENTITY_FOR'] },
        { direction: 'out', relationshipTypes: ['WORKS_AT'] },
      ],
      returnMode: 'path',
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).toContain('.outE(');
    expect(result.query).toContain('.inV()');
    expect(result.query).toContain('.path().by(valueMap(true))');
  });

  it("never emits .dedup() in 'path' mode, even when spec.dedup is true", () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [{ direction: 'out', relationshipTypes: ['WORKS_AT'] }],
      returnMode: 'path',
      dedup: true,
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).not.toContain('.dedup()');
  });
});
