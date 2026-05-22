import { describe, it, expect } from 'vitest';
import { CypherCompiler } from './CypherCompiler.js';
import type { TraversalSpec } from '../../types/traversal.js';
import type { MemoryVocabulary } from '../../types/vocabulary.js';

const compiler = new CypherCompiler();

const emptyVocab: MemoryVocabulary = {
  version: '1.0.0',
  lastModified: '',
  modifiedBy: '',
  entityTypes: [],
  relationshipTypes: [],
};

describe('CypherCompiler', () => {
  it('reports language as cypher', () => {
    expect(compiler.language).toBe('cypher');
  });

  it('compiles a simple single-hop traversal', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'entity-1' },
      steps: [{ direction: 'out', relationshipTypes: ['HAS_COMPONENT'] }],
      returnMode: 'terminal',
    };
    const result = compiler.compile(spec, emptyVocab);

    expect(result.query).toContain('MATCH');
    expect(result.query).toContain('n0.id =');
    expect(result.query).toContain(':HAS_COMPONENT');
    expect(result.query).toContain('->');
    expect(result.query).toContain('RETURN DISTINCT');
    expect(result.query).toContain('LIMIT');
    expect(Object.values(result.params)).toContain('entity-1');
  });

  it('compiles an inbound traversal', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'entity-1' },
      steps: [{ direction: 'in', relationshipTypes: ['BELONGS_TO'] }],
      returnMode: 'terminal',
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).toContain('<-[r0:BELONGS_TO]-');
  });

  it('compiles a both-direction traversal', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'entity-1' },
      steps: [{ direction: 'both' }],
      returnMode: 'terminal',
    };
    const result = compiler.compile(spec, emptyVocab);
    // Both direction uses undirected pattern (no arrow)
    expect(result.query).toMatch(/-\[r0\]-\(/);
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
    expect(result.query).toContain(':HAS_COMPONENT');
    expect(result.query).toContain(':REQUIRES_FLUID');
    // Terminal mode: returns only the last node
    expect(result.query).toContain('RETURN DISTINCT n2');
  });

  it('compiles entity type filters as WHERE clause', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [{ direction: 'out', entityTypes: ['Fluid'] }],
      returnMode: 'terminal',
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).toContain('entityType IN');
  });

  it('compiles relationship property filters', () => {
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
    expect(result.query).toContain('r0.passCount >=');
  });

  it('compiles repeat steps with variable-length path', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [{ direction: 'out', relationshipTypes: ['CONTAINS'], repeat: { maxDepth: 5 } }],
      returnMode: 'terminal',
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).toContain('*1..5');
  });

  it('compiles path return mode with all nodes and rels', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [
        { direction: 'out', relationshipTypes: ['HAS_COMPONENT'] },
        { direction: 'out', relationshipTypes: ['REQUIRES_FLUID'] },
      ],
      returnMode: 'path',
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).toContain('RETURN n0, n1, n2, r0, r1');
  });

  it('includes SKIP when offset > 0', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [{ direction: 'out' }],
      returnMode: 'terminal',
      offset: 10,
      limit: 20,
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).toContain('SKIP');
    expect(result.params['_offset']).toBe(10);
  });

  it('omits DISTINCT when dedup is false', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [{ direction: 'out' }],
      returnMode: 'terminal',
      dedup: false,
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).not.toContain('DISTINCT');
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
    expect(result.query).not.toContain('DROP TABLE');
    expect(Object.values(result.params)).toContain("'; DROP TABLE");
  });
});
