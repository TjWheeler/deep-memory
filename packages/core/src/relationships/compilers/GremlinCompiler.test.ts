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
    // entityId-anchored starts emit hasId(p) (direct doc fetch by system id),
    // not has('id', p) (property-equality lookup).
    expect(result.query).toMatch(/\.hasId\(p\d+\)/);
    expect(result.query).not.toContain(".has('id',");
    expect(result.query).toContain('.out(');
    expect(result.query).toContain('.dedup()');
    expect(result.query).toContain('.range(');
    // Vertex project chain (not valueMap(true)) on the terminal mode.
    expect(result.query).toContain(".project('__kind','id','entityType'");
    expect(result.query).toContain(".by(constant('v'))");
    expect(result.query).toContain('.by(id)');
    expect(result.query).not.toContain('valueMap(true)');
    expect(result.query).not.toContain("'embedding'");
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

  it('emits .times() with a literal integer (CosmosDB rejects parameter bindings on times())', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [{ direction: 'out', repeat: { maxDepth: 3 } }],
      returnMode: 'terminal',
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).toContain('.times(3)');
    // maxDepth must NOT appear as a binding value
    expect(Object.values(result.params)).not.toContain(3);
  });

  it('rejects non-positive-integer repeat.maxDepth', () => {
    expect(() =>
      compiler.compile(
        {
          start: { entityId: 'e1' },
          steps: [{ direction: 'out', repeat: { maxDepth: 0 } }],
          returnMode: 'terminal',
        },
        emptyVocab,
      ),
    ).toThrow(/positive integer/);
    expect(() =>
      compiler.compile(
        {
          start: { entityId: 'e1' },
          steps: [{ direction: 'out', repeat: { maxDepth: 2.5 } }],
          returnMode: 'terminal',
        },
        emptyVocab,
      ),
    ).toThrow(/positive integer/);
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

  it('emits hasId() for entityId-anchored starts', () => {
    // Direct doc fetch by system id, not property-equality lookup. See
    // docs/cosmosdb-gremlin-compatibility.md §Performance.
    const spec: TraversalSpec = {
      start: { entityId: 'alice-johnson' },
      steps: [{ direction: 'out', relationshipTypes: ['WORKS_AT'] }],
      returnMode: 'terminal',
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).toMatch(/g\.V\(\)\.hasId\(p\d+\)/);
    expect(result.query).not.toContain(".has('id',");
    expect(Object.values(result.params)).toContain('alice-johnson');
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

  // ─── 'all' mode — union + server-side dedup ──

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
    // Branches end in their own per-type project chain.
    expect(result.query).toMatch(/__\.outE\(p\d+\)\.project\('__kind','id','relationshipType'/);
    expect(result.query).toMatch(/__\.outE\(p\d+\)\.inV\(\)\.project\('__kind','id','entityType'/);
    expect(result.query).toMatch(/__\.outE\(p\d+\)\.inV\(\)\.outE\(p\d+\)\.project\('__kind','id','relationshipType'/);
    expect(result.query).toMatch(/__\.outE\(p\d+\)\.inV\(\)\.outE\(p\d+\)\.inV\(\)\.project\('__kind','id','entityType'/);

    // 'all' is inherently deduped server-side, spec.dedup is ignored. On
    // projected Maps, dedup must select the id key (string property-name
    // doesn't resolve on a Map in CosmosDB Gremlin's subset).
    expect(result.query).toContain(`.dedup().by(select('id'))`);

    // No post-union projection step — projection happened per-branch.
    expect(result.query).not.toContain('valueMap(true)');
    expect(result.query).not.toContain('.path()');
    expect(result.query).not.toContain("'embedding'");
  });

  it("emits vertex branch before edge branch at each depth in 'all' mode union", () => {
    // Ordering invariant: within each depth, the vertex branch must precede
    // the edge branch in the union. The deduped+ranged stream is then closed
    // under per-hop entity references — an edge in any .range() prefix is
    // preceded by the vertex it newly introduced, so single-hop pagination
    // returns a referentially self-contained slice for any limit.
    const spec: TraversalSpec = {
      start: { entityId: 'start' },
      steps: [
        { direction: 'out', relationshipTypes: ['R1'] },
        { direction: 'out', relationshipTypes: ['R2'] },
      ],
      returnMode: 'all',
    };
    const result = compiler.compile(spec, emptyVocab);

    // Depth-1 vertex branch (outE.inV) must appear before depth-1 edge branch
    // (outE alone) in the union string. Both end in their per-type project chain
    // which is the disambiguator vs deeper-depth branches that share a prefix.
    const depth1Vertex = result.query.search(
      /__\.outE\(p\d+\)\.inV\(\)\.project\('__kind','id','entityType'/,
    );
    const depth1Edge = result.query.search(
      /__\.outE\(p\d+\)\.project\('__kind','id','relationshipType'/,
    );
    expect(depth1Vertex).toBeGreaterThan(-1);
    expect(depth1Edge).toBeGreaterThan(-1);
    expect(depth1Vertex).toBeLessThan(depth1Edge);

    // Depth-2 vertex branch (…outE.inV.outE.inV) must appear before depth-2
    // edge branch (…outE.inV.outE). Both share the depth-1 prefix.
    const depth2Vertex = result.query.search(
      /__\.outE\(p\d+\)\.inV\(\)\.outE\(p\d+\)\.inV\(\)\.project\('__kind','id','entityType'/,
    );
    const depth2Edge = result.query.search(
      /__\.outE\(p\d+\)\.inV\(\)\.outE\(p\d+\)\.project\('__kind','id','relationshipType'/,
    );
    expect(depth2Vertex).toBeGreaterThan(-1);
    expect(depth2Edge).toBeGreaterThan(-1);
    expect(depth2Vertex).toBeLessThan(depth2Edge);
  });

  it("compiles 'all' mode with .dedup() even when spec.dedup is false", () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [{ direction: 'out', relationshipTypes: ['HAS_COMPONENT'] }],
      returnMode: 'all',
      dedup: false,
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).toContain(`.dedup().by(select('id'))`);
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

  it("compiles 'path' mode with edge-explicit emission and two-by round-robin path projection", () => {
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
    // Two-by round-robin — vertex project then edge project. A single by()
    // across mixed path objects crashes when an edge lacks a vertex-only key.
    expect(result.query).toMatch(
      /\.path\(\)\.by\(project\('__kind','id','entityType'.+\)\.by\(project\('__kind','id','relationshipType'/,
    );
    expect(result.query).not.toContain('valueMap(true)');
    expect(result.query).not.toContain("'embedding'");
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

  // ─── simplePath() for cycle prevention in 'path' mode ──

  it("always emits .simplePath() before .range() and .path() in 'path' mode, and never in 'terminal' or 'all'", () => {
    const pathSpec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [
        { direction: 'both' },
        { direction: 'both' },
      ],
      returnMode: 'path',
    };
    const pathResult = compiler.compile(pathSpec, emptyVocab);
    expect(pathResult.query).toContain('.simplePath()');
    // simplePath must come before .range() (which comes before .path()) so it
    // filters traversers, not collected Path objects.
    const sp = pathResult.query.indexOf('.simplePath()');
    const range = pathResult.query.indexOf('.range(');
    const path = pathResult.query.indexOf('.path(');
    expect(sp).toBeGreaterThan(-1);
    expect(sp).toBeLessThan(range);
    expect(range).toBeLessThan(path);

    const terminalSpec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [{ direction: 'out' }],
      returnMode: 'terminal',
    };
    expect(compiler.compile(terminalSpec, emptyVocab).query).not.toContain('.simplePath()');

    const allSpec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [{ direction: 'both', relationshipTypes: ['WORKS_AT'] }],
      returnMode: 'all',
    };
    expect(compiler.compile(allSpec, emptyVocab).query).not.toContain('.simplePath()');
  });

  // ─── Server-side projection — group/dedup/values terminals ──

  describe('projection', () => {
    it('emits group/count/unfold when mode is count', () => {
      const spec: TraversalSpec = {
        start: { entityType: 'Organization' },
        returnMode: 'terminal',
        projection: { properties: ['orgType'], mode: 'count' },
        limit: 200,
      };
      const result = compiler.compile(spec, emptyVocab);
      expect(result.query).toContain(
        `.group().by(values('orgType')).by(count()).unfold()`,
      );
      // The vertex project chain that normally terminates a terminal-mode
      // query is suppressed — projection owns the row shape.
      expect(result.query).not.toContain("'__kind'");
      expect(result.query).not.toContain('valueMap(true)');
    });

    it('emits .dedup() when distinct is true and mode is values', () => {
      const spec: TraversalSpec = {
        start: { entityType: 'Equipment' },
        returnMode: 'terminal',
        projection: { properties: ['equipmentType'], distinct: true },
      };
      const result = compiler.compile(spec, emptyVocab);
      expect(result.query).toContain(`.values('equipmentType').dedup()`);
      expect(result.query).not.toContain('count()');
    });

    it('emits one row per match in plain values mode (no dedup, no count)', () => {
      const spec: TraversalSpec = {
        start: { entityType: 'Fluid' },
        returnMode: 'terminal',
        projection: { properties: ['fluidType'] },
      };
      const result = compiler.compile(spec, emptyVocab);
      expect(result.query).toContain(`.values('fluidType')`);
      expect(result.query).not.toContain('.dedup()');
      expect(result.query).not.toContain('count()');
    });

    it('projects multiple properties as separate .by(values(...)) modulators', () => {
      const spec: TraversalSpec = {
        start: { entityType: 'Equipment' },
        returnMode: 'terminal',
        projection: { properties: ['equipmentType', 'tier'], mode: 'count' },
      };
      const result = compiler.compile(spec, emptyVocab);
      expect(result.query).toContain(
        `.group().by(project('equipmentType','tier').by(values('equipmentType')).by(values('tier'))).by(count()).unfold()`,
      );
    });

    it('uses the single-property shortcut (no project wrapper) for count and distinct', () => {
      // Single-property emissions skip the project('p').by(values('p')) wrapper
      // and use the bare values('p') terminal — smaller emission and one less
      // Map layer for the parser to walk.
      const countSpec: TraversalSpec = {
        start: { entityType: 'Organization' },
        returnMode: 'terminal',
        projection: { properties: ['orgType'], mode: 'count' },
      };
      const countResult = compiler.compile(countSpec, emptyVocab);
      expect(countResult.query).toContain(
        `.group().by(values('orgType')).by(count()).unfold()`,
      );
      expect(countResult.query).not.toContain(`project('orgType')`);

      const distinctSpec: TraversalSpec = {
        start: { entityType: 'Equipment' },
        returnMode: 'terminal',
        projection: { properties: ['equipmentType'], distinct: true },
      };
      const distinctResult = compiler.compile(distinctSpec, emptyVocab);
      expect(distinctResult.query).toContain(`.values('equipmentType').dedup()`);
      expect(distinctResult.query).not.toContain(`project('equipmentType')`);
    });

    it('projects the terminal anchor after multi-hop steps', () => {
      // In Gremlin the terminal anchor is positional — projection is appended
      // after the final hop's vertex emission. Verify both hops AND the
      // projection terminal appear in order.
      const spec: TraversalSpec = {
        start: { entityId: 'Equipment:pc7000' },
        steps: [
          { direction: 'out', relationshipTypes: ['HAS_COMPONENT'] },
          { direction: 'out', relationshipTypes: ['REQUIRES_FLUID'] },
        ],
        returnMode: 'terminal',
        projection: { properties: ['fluidType'], mode: 'count' },
      };
      const result = compiler.compile(spec, emptyVocab);

      const outCount = (result.query.match(/\.out\(/g) ?? []).length;
      expect(outCount).toBe(2);
      expect(result.query).toContain(
        `.group().by(values('fluidType')).by(count()).unfold()`,
      );

      const firstOut = result.query.indexOf('.out(');
      const lastOut = result.query.lastIndexOf('.out(');
      const projection = result.query.indexOf('.group()');
      expect(firstOut).toBeLessThan(lastOut);
      expect(lastOut).toBeLessThan(projection);
    });

    it('rejects unsafe projection property names', () => {
      // Identifier-position values like values('p') can't be parameterised in
      // Gremlin — anything other than the documented identifier shape must
      // throw before reaching emission.
      const spec: TraversalSpec = {
        start: { entityType: 'Organization' },
        returnMode: 'terminal',
        projection: { properties: [`orgType').values('embedding`], mode: 'count' },
      };
      expect(() => compiler.compile(spec, emptyVocab)).toThrow(
        /Unsafe projection property name/,
      );
    });

    it('drops projection silently when returnMode is path', () => {
      const spec: TraversalSpec = {
        start: { entityId: 'a' },
        steps: [{ direction: 'both', repeat: { maxDepth: 3 } }],
        returnMode: 'path',
        projection: { properties: ['anything'], mode: 'count' },
      };
      const result = compiler.compile(spec, emptyVocab);
      // The path emission shape is unchanged — no projection terminal slipped
      // in. `count()` and the projected property name are absent.
      expect(result.query).toContain('.path()');
      expect(result.query).not.toContain('count()');
      expect(result.query).not.toContain(`values('anything')`);
    });

    it('drops projection silently when returnMode is all', () => {
      const spec: TraversalSpec = {
        start: { entityId: 'a' },
        steps: [{ direction: 'out', relationshipTypes: ['KNOWS'] }],
        returnMode: 'all',
        projection: { properties: ['anything'], mode: 'count' },
      };
      const result = compiler.compile(spec, emptyVocab);
      // 'all' emits the union+dedup branch shape regardless of projection.
      expect(result.query).toContain('.union(');
      expect(result.query).toContain(`.dedup().by(select('id'))`);
      expect(result.query).not.toContain('count()');
      expect(result.query).not.toContain(`values('anything')`);
    });
  });
});
