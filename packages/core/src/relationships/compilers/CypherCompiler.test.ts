import { describe, it, expect } from 'vitest';
import { CypherCompiler } from './CypherCompiler.js';
import { TraversalValidationError } from '../../core/errors.js';
import type { TraversalSpec, TraversalStep } from '../../types/traversal.js';
import type { MemoryVocabulary } from '../../types/vocabulary.js';
import type { PropertyFilter } from '../../types/queries.js';

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

  it('compiles all return mode with single-hop nodes and relationship', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [{ direction: 'out', relationshipTypes: ['KNOWS'] }],
      returnMode: 'all',
    };
    const result = compiler.compile(spec, emptyVocab);
    // 'all' mode must emit both endpoints AND the relationship — the provider's
    // executeTraversal discriminates Node vs Relationship objects per column to
    // populate the entities and relationships arrays in TraversalResult.
    expect(result.query).toContain('RETURN DISTINCT n0, n1, r0');
  });

  it('compiles all return mode with two-hop nodes and relationships', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [
        { direction: 'out', relationshipTypes: ['HAS_COMPONENT'] },
        { direction: 'out', relationshipTypes: ['REQUIRES_FLUID'] },
      ],
      returnMode: 'all',
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).toContain('RETURN DISTINCT n0, n1, n2, r0, r1');
  });

  it('compiles all return mode with repeat step', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [{ direction: 'out', relationshipTypes: ['CONTAINS'], repeat: { maxDepth: 3 } }],
      returnMode: 'all',
    };
    const result = compiler.compile(spec, emptyVocab);
    // One step → one relationship alias, regardless of repeat maxDepth. The
    // variable-length pattern collapses into r0 even at maxDepth > 1.
    expect(result.query).toContain('*1..3');
    expect(result.query).toContain('RETURN DISTINCT n0, n1, r0');
  });

  it('omits DISTINCT in all return mode when dedup is false', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [{ direction: 'out', relationshipTypes: ['KNOWS'] }],
      returnMode: 'all',
      dedup: false,
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).toContain('RETURN n0, n1, r0');
    expect(result.query).not.toContain('DISTINCT');
  });

  it('compiles path return mode with path binding', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [
        { direction: 'out', relationshipTypes: ['HAS_COMPONENT'] },
        { direction: 'out', relationshipTypes: ['REQUIRES_FLUID'] },
      ],
      returnMode: 'path',
    };
    const result = compiler.compile(spec, emptyVocab);
    expect(result.query).toContain('MATCH p = (n0)');
    expect(result.query).toContain('RETURN nodes(p) AS pathNodes, relationships(p) AS pathRels, length(p) AS pathLength');
  });

  it('compiles path mode with repeat step capturing intermediates via nodes(p)', () => {
    const spec: TraversalSpec = {
      start: { entityId: 'e1' },
      steps: [{ direction: 'both', repeat: { maxDepth: 5, emitIntermediates: true } }],
      returnMode: 'path',
    };
    const result = compiler.compile(spec, emptyVocab);
    // Variable-length patterns compress every intermediate node into one hop
    // alias; the path binding lets nodes(p) / relationships(p) recover them.
    expect(result.query).toContain('MATCH p = (n0)-[r0*1..5]-(n1)');
    expect(result.query).toContain('RETURN nodes(p) AS pathNodes, relationships(p) AS pathRels, length(p) AS pathLength');
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

  describe('projection', () => {
    it('emits count grouping when mode is count', () => {
      const spec: TraversalSpec = {
        start: { entityType: 'Organization' },
        returnMode: 'terminal',
        projection: { properties: ['orgType'], mode: 'count' },
        limit: 200,
      };
      const result = compiler.compile(spec, emptyVocab);
      expect(result.query).toContain('RETURN n0.orgType AS orgType, count(*) AS count');
      expect(result.query).not.toContain('RETURN DISTINCT n0\n');
    });

    it('emits DISTINCT when distinct is true and mode is values', () => {
      const spec: TraversalSpec = {
        start: { entityType: 'Equipment' },
        returnMode: 'terminal',
        projection: { properties: ['equipmentType'], distinct: true },
      };
      const result = compiler.compile(spec, emptyVocab);
      expect(result.query).toContain('RETURN DISTINCT n0.equipmentType AS equipmentType');
    });

    it('emits one row per match in plain values mode (no DISTINCT, no count)', () => {
      const spec: TraversalSpec = {
        start: { entityType: 'Fluid' },
        returnMode: 'terminal',
        projection: { properties: ['fluidType'] },
      };
      const result = compiler.compile(spec, emptyVocab);
      expect(result.query).toContain('RETURN n0.fluidType AS fluidType');
      expect(result.query).not.toContain('DISTINCT');
      expect(result.query).not.toContain('count(*)');
    });

    it('projects multiple properties as separate aliased columns', () => {
      const spec: TraversalSpec = {
        start: { entityType: 'Equipment' },
        returnMode: 'terminal',
        projection: { properties: ['equipmentType', 'tier'], mode: 'count' },
      };
      const result = compiler.compile(spec, emptyVocab);
      expect(result.query).toContain('n0.equipmentType AS equipmentType');
      expect(result.query).toContain('n0.tier AS tier');
      expect(result.query).toContain('count(*) AS count');
    });

    it('projects the terminal alias after multi-hop steps', () => {
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
      expect(result.query).toContain('n2.fluidType AS fluidType');
      expect(result.query).toContain('count(*) AS count');
    });

    it('rejects unsafe projection property names', () => {
      const spec: TraversalSpec = {
        start: { entityType: 'Organization' },
        returnMode: 'terminal',
        projection: { properties: ['orgType, count(*) // injection'], mode: 'count' },
      };
      expect(() => compiler.compile(spec, emptyVocab)).toThrow(/Unsafe projection property name/);
    });

    it('drops projection silently when returnMode is path', () => {
      const spec: TraversalSpec = {
        start: { entityId: 'a' },
        steps: [{ direction: 'both', repeat: { maxDepth: 3 } }],
        returnMode: 'path',
        projection: { properties: ['anything'], mode: 'count' },
      };
      const result = compiler.compile(spec, emptyVocab);
      expect(result.query).toContain('RETURN nodes(p) AS pathNodes');
      expect(result.query).not.toContain('count(*)');
    });

    it('drops projection silently when returnMode is all', () => {
      const spec: TraversalSpec = {
        start: { entityId: 'a' },
        steps: [{ direction: 'out' }],
        returnMode: 'all',
        projection: { properties: ['anything'], mode: 'count' },
      };
      const result = compiler.compile(spec, emptyVocab);
      expect(result.query).not.toContain('count(*)');
      expect(result.query).toMatch(/RETURN DISTINCT n0, n1, r0/);
    });
  });

  describe('identifier safety', () => {
    // Untyped input (e.g. parsed JSON from a tool call) can carry a value of
    // the wrong runtime type into a typed spec field.
    const asNumber = (value: number | string): number => value as number;
    const asStringList = (value: string[] | string): string[] => value as string[];
    const asFilters = (value: PropertyFilter[] | PropertyFilter | string | null[]): PropertyFilter[] => value as PropertyFilter[];
    const asStep = (value: TraversalStep | null): TraversalStep => value as TraversalStep;
    const asSteps = (value: TraversalStep[] | TraversalStep): TraversalStep[] => value as TraversalStep[];

    const filterKeyInjection = 'id IS NOT NULL OR true OR n0.id';
    const relTypeInjection = 'KNOWS]-() WITH 1 AS x MATCH (m:_Entity) RETURN m //';

    function compileWithFilter(key: string, where: 'start' | 'entity' | 'relationship'): () => void {
      const filter = [{ key, operator: 'eq' as const, value: 'x' }];
      const spec: TraversalSpec = {
        start: where === 'start' ? { entityId: 'a', filter } : { entityId: 'a' },
        steps: [
          {
            direction: 'out',
            ...(where === 'entity' ? { entityFilter: filter } : {}),
            ...(where === 'relationship' ? { relationshipFilter: filter } : {}),
          },
        ],
        returnMode: 'terminal',
      };
      return () => compiler.compile(spec, emptyVocab);
    }

    function compileWithDepth(maxDepth: number): () => void {
      return () =>
        compiler.compile(
          {
            start: { entityId: 'a' },
            steps: [{ direction: 'out', repeat: { maxDepth } }],
            returnMode: 'terminal',
          },
          emptyVocab,
        );
    }

    it.each(['start', 'entity', 'relationship'] as const)(
      'rejects an injected %s filter key with TraversalValidationError',
      (where) => {
        const run = compileWithFilter(filterKeyInjection, where);
        expect(run).toThrow(TraversalValidationError);
        expect(run).toThrow(/Unsafe property filter key/);
      },
    );

    it('rejects an injected relationship type with TraversalValidationError', () => {
      const run = () =>
        compiler.compile(
          {
            start: { entityId: 'a' },
            steps: [{ direction: 'out', relationshipTypes: ['KNOWS', relTypeInjection] }],
            returnMode: 'terminal',
          },
          emptyVocab,
        );
      expect(run).toThrow(TraversalValidationError);
      expect(run).toThrow(/Unsafe relationship type in steps\[0\]/);
    });

    it('rejects the injection strings in the other position too', () => {
      expect(compileWithFilter(relTypeInjection, 'relationship')).toThrow(TraversalValidationError);
      expect(() =>
        compiler.compile(
          {
            start: { entityId: 'a' },
            steps: [{ direction: 'both', relationshipTypes: [filterKeyInjection] }],
            returnMode: 'terminal',
          },
          emptyVocab,
        ),
      ).toThrow(TraversalValidationError);
    });

    it('rejects a hyphenated filter key', () => {
      expect(compileWithFilter('start-date', 'entity')).toThrow(TraversalValidationError);
    });

    it('rejects an unsafe projection property name with TraversalValidationError', () => {
      expect(() =>
        compiler.compile(
          {
            start: { entityType: 'Organization' },
            returnMode: 'terminal',
            projection: { properties: ['start-date'] },
          },
          emptyVocab,
        ),
      ).toThrow(TraversalValidationError);
    });

    it.each(['createdInConversation', 'slug', 'embedding', '_attempt'])(
      'rejects projecting the entity system field %s',
      (name) => {
        expect(() =>
          compiler.compile(
            {
              start: { entityType: 'Organization' },
              returnMode: 'terminal',
              projection: { properties: [name] },
            },
            emptyVocab,
          ),
        ).toThrow(/reserved for an entity system field/);
      },
    );

    it.each([
      ['a fractional depth', 1.5],
      ['a numeric string', asNumber('3')],
      ['NaN', Number.NaN],
      ['zero', 0],
      ['a negative depth', -2],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ])('rejects repeat.maxDepth of %s', (_label, maxDepth) => {
      const run = compileWithDepth(maxDepth);
      expect(run).toThrow(TraversalValidationError);
      expect(run).toThrow(/steps\[0\]\.repeat\.maxDepth must be a positive integer/);
    });

    it('rejects an unknown step direction rather than emitting a malformed pattern', () => {
      expect(() =>
        compiler.compile(
          {
            start: { entityId: 'a' },
            steps: [{ direction: 'sideways' as 'out' }],
            returnMode: 'terminal',
          },
          emptyVocab,
        ),
      ).toThrow(TraversalValidationError);
    });

    it('rejects an unknown filter operator rather than emitting a malformed clause', () => {
      expect(() =>
        compiler.compile(
          {
            start: { entityId: 'a', filter: [{ key: 'name', operator: 'like' as 'eq', value: 'x' }] },
            returnMode: 'terminal',
          },
          emptyVocab,
        ),
      ).toThrow(TraversalValidationError);
    });

    it('still compiles safe identifiers and depths', () => {
      const result = compiler.compile(
        {
          start: { entityId: 'a', filter: [{ key: '_status', operator: 'eq', value: 'active' }] },
          steps: [
            {
              direction: 'out',
              relationshipTypes: ['HAS_COMPONENT', 'part_of2'],
              entityFilter: [{ key: 'startDate', operator: 'isNotNull' }],
              relationshipFilter: [{ key: 'weight', operator: 'gte', value: 2 }],
              repeat: { maxDepth: 4 },
            },
          ],
          returnMode: 'terminal',
        },
        emptyVocab,
      );
      expect(result.query).toContain('n0._status = $');
      expect(result.query).toContain('-[r0:HAS_COMPONENT|part_of2*1..4]->(n1)');
      expect(result.query).toContain('n1.startDate IS NOT NULL');
      expect(result.query).toContain('r0.weight >= $');
    });

    it.each([
      ['relationshipTypes', { direction: 'out' as const, relationshipTypes: asStringList('KNOWS') }],
      ['entityTypes', { direction: 'out' as const, entityTypes: asStringList('Person') }],
      ['entityFilter', { direction: 'out' as const, entityFilter: asFilters('name') }],
      ['relationshipFilter', { direction: 'out' as const, relationshipFilter: asFilters('since') }],
      ['a null filter element', { direction: 'out' as const, relationshipFilter: asFilters([null]) }],
    ])('rejects a non-array or malformed %s with TraversalValidationError', (_label, step) => {
      expect(() =>
        compiler.compile({ start: { entityId: 'a' }, steps: [step], returnMode: 'terminal' }, emptyVocab),
      ).toThrow(TraversalValidationError);
    });

    it.each([
      ['a non-array steps', asSteps({ direction: 'out' })],
      ['a null step element', [{ direction: 'out' as const }, asStep(null)]],
    ])('rejects %s with TraversalValidationError', (_label, steps) => {
      expect(() =>
        compiler.compile({ start: { entityId: 'a' }, steps, returnMode: 'all' }, emptyVocab),
      ).toThrow(TraversalValidationError);
    });

    it('rejects a non-array projection.properties', () => {
      expect(() =>
        compiler.compile(
          { start: { entityId: 'a' }, returnMode: 'terminal', projection: { properties: asStringList('name') } },
          emptyVocab,
        ),
      ).toThrow(TraversalValidationError);
    });
  });
});
