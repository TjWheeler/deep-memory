import { describe, it, expect } from 'vitest';
import {
  GREMLIN_VERTEX_PROJECTION_FIELDS,
  GREMLIN_EDGE_PROJECTION_FIELDS,
  buildVertexProjectChain,
  buildEdgeProjectChain,
} from '@utaba/deep-memory';
import {
  STORED_ENTITY_FIELDS,
  STORED_RELATIONSHIP_FIELDS,
  STORED_REPOSITORY_FIELDS,
  buildRepositoryProjectChain,
} from './mapping.js';

// Phase 1 perf-fixes contract: the GremlinCompiler emits a fixed project chain
// listing the keys the storage-cosmosdb mappers consume. The two lists live
// in different packages (the compiler in core can't import from
// storage-cosmosdb because the dependency graph runs the other way). This
// test asserts they don't drift.

describe('Gremlin projection field-list sync (Phase 1 contract)', () => {
  it('vertex projection fields match the stored-entity mapper input set', () => {
    expect(
      [...GREMLIN_VERTEX_PROJECTION_FIELDS].sort(),
    ).toEqual([...STORED_ENTITY_FIELDS].sort());
  });

  it('edge projection fields match the stored-relationship mapper input set', () => {
    expect(
      [...GREMLIN_EDGE_PROJECTION_FIELDS].sort(),
    ).toEqual([...STORED_RELATIONSHIP_FIELDS].sort());
  });

  it('neither list includes embedding (Phase 1 contract: never wire-ship embeddings on read)', () => {
    expect(GREMLIN_VERTEX_PROJECTION_FIELDS).not.toContain('embedding');
    expect(STORED_ENTITY_FIELDS).not.toContain('embedding');
  });
});

// Phase 2 perf-fixes contract: the public project-chain builders return the
// exact Gremlin string the non-traversal read paths emit. The chain text is
// covered by the GremlinCompiler unit tests for the compiler side; the tests
// below pin shape invariants used by every read-path caller.

describe('buildVertexProjectChain / buildEdgeProjectChain (Phase 2 contract)', () => {
  it('vertex chain default omits embedding', () => {
    expect(buildVertexProjectChain()).not.toMatch(/'embedding'/);
  });

  it('vertex chain with embedding option appends an embedding key', () => {
    const withEmbedding = buildVertexProjectChain({ withEmbedding: true });
    expect(withEmbedding).toMatch(/'embedding'/);
    expect(withEmbedding).toMatch(/coalesce\(values\('embedding'\), constant\(''\)\)/);
  });

  it('vertex chain always emits the __kind discriminator', () => {
    expect(buildVertexProjectChain()).toMatch(/'__kind'/);
    expect(buildVertexProjectChain()).toMatch(/constant\('v'\)/);
  });

  it('edge chain emits the __kind discriminator with value "e" and no embedding', () => {
    const chain = buildEdgeProjectChain();
    expect(chain).toMatch(/'__kind'/);
    expect(chain).toMatch(/constant\('e'\)/);
    expect(chain).not.toMatch(/'embedding'/);
  });

  it('vertex chain default and embedding-on shapes are distinct strings', () => {
    expect(buildVertexProjectChain()).not.toBe(buildVertexProjectChain({ withEmbedding: true }));
  });
});

describe('buildRepositoryProjectChain (Phase 2)', () => {
  it('emits a project chain covering the STORED_REPOSITORY_FIELDS keys', () => {
    const chain = buildRepositoryProjectChain();
    for (const field of STORED_REPOSITORY_FIELDS) {
      // 'id' is read via `.by(id)` (the Gremlin token) — exclude it from the
      // string-match assertion. Every other field appears as a quoted key.
      if (field === 'id') continue;
      expect(chain).toContain(`'${field}'`);
    }
  });

  it('uses coalesce defaults for optional fields and bare .by for required fields', () => {
    const chain = buildRepositoryProjectChain();
    // required
    expect(chain).toMatch(/\.by\('repositoryId'\)/);
    expect(chain).toMatch(/\.by\('repoLabel'\)/);
    expect(chain).toMatch(/\.by\('governanceConfig'\)/);
    expect(chain).toMatch(/\.by\('createdAt'\)/);
    expect(chain).toMatch(/\.by\('createdBy'\)/);
    // optional
    expect(chain).toMatch(/coalesce\(values\('description'\), constant\(''\)\)/);
    expect(chain).toMatch(/coalesce\(values\('metadata'\), constant\(''\)\)/);
  });
});
