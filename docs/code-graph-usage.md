# Code Graph — Query Reference (distilled)

Minimal reference for **querying** the optional deep-memory code graph. For what it is, why it's optional, and how to build it, see [code-graph.md](code-graph.md). Load *this* doc when you need to query; it's kept terse on purpose.

**Open first (once per session):** `memory_open_repository({ repositoryId: "d33c0de0-9a1b-4c2d-8e3f-1a2b3c4d5e6f" })` — via the `deep-memory` MCP server (tools are `mcp__deep-memory__memory_*`).

## Three rules

- **No embeddings.** `memory_find_entities({ searchTerm })` always returns empty — never conclude something is absent from a miss. Enumerate by type or traverse from a slug.
- **Slugs** are `EntityType:lowercased-label` with every run of non-alphanumeric chars collapsed to `-`. Examples: `ProviderContract:storageprovider`, `ProviderImpl:sqlserverstorageprovider`, `McpServer:utaba-deep-memory-local-mcp-server`, `McpTool:memory-create-entities`, `Package:utaba-deep-memory`, `ErrorType:repositorynotfounderror`, `Module:packages-core-src-core-deepmemory-ts`. Unsure of a slug? Enumerate the type (below) and read the labels.
- **Static facts, as of the last rebuild.** Optional and may be unbuilt — if a call errors, it isn't built (`pnpm code-graph:rebuild`, needs local Neo4j); fall back to grep/Explore. An edge means a call site/declaration exists, **not** that a path runs.

## Model

| Entity | Key props |
|--------|-----------|
| `Package` | `isWorkspace`, `isCore`, `dir` |
| `ProviderContract` | `filePath` |
| `ProviderImpl` | `filePath` |
| `McpServer` | `kind`, `toolPrefix` |
| `McpTool` | `domain`, `mutates` |
| `Doc` / `Test` | `filePath` |
| `Module` | `filePath`, `package`, `isBarrel`, `throwsRawError`, `inImportCycle` |
| `ErrorType` | `filePath`, `package`, `extendsBuiltin` |

```
Package      ─DEPENDS_ON_PACKAGE→ Package        (edge prop depType: dependency|peerDependency|devDependency)
ProviderImpl ─IMPLEMENTS→         ProviderContract (edge prop detection: nominal|structural)
Package      ─CONTAINS→           ProviderContract | ProviderImpl | McpServer | ErrorType
McpServer    ─ADVERTISES→         McpTool
Module       ─DEFINES→            ProviderContract | ProviderImpl | McpServer | McpTool | ErrorType  (the file declaring the construct)
Doc          ─DOCUMENTS→          ProviderContract | ProviderImpl | McpServer | McpTool | Module  (link to a provider/tool file → construct; any other .ts → Module)
Doc          ─MENTIONS→           ProviderContract | ProviderImpl | ErrorType
Doc          ─DESCRIBES→          Package          (package README → its package)
Test         ─COVERS→             ProviderImpl | ProviderContract | McpTool | Module  (edge prop role: subject|fixture; Module from a resolved relative import)
Module       ─IMPORTS→            Module | Package  (file-level: imports another file, or a package)
Module       ─THROWS→             ErrorType        (a `throw new XError()` site)
ErrorType    ─EXTENDS→            ErrorType        (subclass → superclass; catchability chain)
```

`Module.inImportCycle = true` ⟺ the file is in a circular import (SCC of size > 1 over `IMPORTS`) — a defect; the project forbids circular deps.

## Recipes (question → call)

| Question | Call |
|----------|------|
| Blast radius: change a contract → impls + tests that break | `memory_explore_neighborhood({ entityId: "ProviderContract:storageprovider", direction: "in", relationshipTypes: ["IMPLEMENTS","COVERS"] })` |
| What does a package depend on | `memory_explore_neighborhood({ entityId: "Package:utaba-deep-memory-indexer", direction: "out", relationshipTypes: ["DEPENDS_ON_PACKAGE"] })` |
| Who depends on a package | same, `direction: "in"` |
| Tools a server exposes (then read `mutates`) | `memory_explore_neighborhood({ entityId: "McpServer:utaba-deep-memory-local-mcp-server", direction: "out", relationshipTypes: ["ADVERTISES"] })` |
| Which docs mention a symbol | `memory_explore_neighborhood({ entityId: "ProviderContract:storageprovider", direction: "in", relationshipTypes: ["MENTIONS","DOCUMENTS"] })` |
| List everything of a type | `memory_query_graph({ start: { entityType: "McpTool" }, limit: 50 })` |
| Distinct values of a property | `memory_query_graph({ start: { entityType: "McpTool" }, projection: { properties: ["domain"], distinct: true }, limit: 200 })` |
| Filter by a node property (native) | `memory_query_graph({ start: { entityType: "McpTool", filter: [{ key: "mutates", operator: "eq", value: true }] }, limit: 50 })` |
| Which file defines a construct | `memory_explore_neighborhood({ entityId: "ProviderContract:storageprovider", direction: "in", relationshipTypes: ["DEFINES"] })` (one Module) |
| What does a file define | `memory_explore_neighborhood({ entityId: "Module:packages-core-src-core-errors-ts", direction: "out", relationshipTypes: ["DEFINES"] })` (errors.ts → all 24 ErrorTypes) |
| Construct's file-level blast radius (who imports its defining file) | `memory_query_graph({ start: { entityId: "ProviderContract:storageprovider" }, steps: [{ direction: "in", relationshipTypes: ["DEFINES"] }, { direction: "in", relationshipTypes: ["IMPORTS"] }] })` |
| Files in an import cycle (a defect) | `memory_query_graph({ start: { entityType: "Module", filter: [{ key: "inImportCycle", operator: "eq", value: true }] }, limit: 50 })` |
| Source files with no covering test | see the untested-modules Cypher below (a `NOT (m)<-[:COVERS]-(:Test)` scan) |
| File blast radius: who imports this file | `memory_explore_neighborhood({ entityId: "Module:packages-core-src-providers-storageprovider-ts", direction: "in", relationshipTypes: ["IMPORTS"] })` |
| Which files import a package (incl. external) | `memory_explore_neighborhood({ entityId: "Package:neo4j-driver", direction: "in", relationshipTypes: ["IMPORTS"] })` |
| What can this file throw | `memory_explore_neighborhood({ entityId: "Module:…", direction: "out", relationshipTypes: ["THROWS"] })` |
| Who throws / catches an error (+ subclasses) | `memory_explore_neighborhood({ entityId: "ErrorType:repositorynotfounderror", direction: "in", relationshipTypes: ["THROWS","EXTENDS"] })` |
| Files breaking the typed-errors convention | `memory_query_graph({ start: { entityType: "Module", filter: [{ key: "throwsRawError", operator: "eq", value: true }] }, limit: 200 })` |
| Which doc explains a package | `memory_explore_neighborhood({ entityId: "Package:utaba-deep-memory-indexer", direction: "in", relationshipTypes: ["DESCRIBES"] })` |

## Raw Cypher (analytics the tools don't expose)

`docker exec deep-memory-neo4j cypher-shell -u neo4j -p DeepMem-Dev-1234 "<query>"` (swap in your own value if you've overridden `NEO4J_PASSWORD` in `.env`). Always scope by `repositoryId` (`$rid = d33c0de0-9a1b-4c2d-8e3f-1a2b3c4d5e6f`). **Edge properties live in a JSON-string blob** (`r.properties`) — match them with `CONTAINS`, not native keys (`{depType:'…'}` won't work in Cypher; the MCP tools return them parsed).

```cypher
// core zero-runtime-dependency invariant — expect 0 rows
MATCH (c:_Entity {repositoryId:$rid, entityType:'Package', isCore:true})-[r:DEPENDS_ON_PACKAGE]->(t {isWorkspace:false})
WHERE r.properties CONTAINS '"depType":"dependency"' OR r.properties CONTAINS '"depType":"peerDependency"'
RETURN t.label;

// provider conformance — contracts by implementation count (0 = unimplemented)
MATCH (c:_Entity {repositoryId:$rid, entityType:'ProviderContract'})
OPTIONAL MATCH (c)<-[:IMPLEMENTS]-(i) RETURN c.label, count(i) ORDER BY count(i) DESC;

// coverage gap — provider nodes no test covers
MATCH (n:_Entity {repositoryId:$rid}) WHERE n.entityType IN ['ProviderContract','ProviderImpl']
AND NOT (n)<-[:COVERS]-() RETURN n.label;

// testing gap — MCP tools with no covering test
MATCH (t:_Entity {repositoryId:$rid, entityType:'McpTool'})
WHERE NOT (t)<-[:COVERS]-() RETURN t.label ORDER BY t.label;

// file blast radius — most-imported source files
MATCH (m:_Entity {repositoryId:$rid, entityType:'Module'})<-[:IMPORTS]-(d:_Entity {entityType:'Module'})
RETURN m.label, count(DISTINCT d) AS importers ORDER BY importers DESC LIMIT 10;

// import cycles — every file flagged by Tarjan's SCC (expect 0 rows; a defect if any)
MATCH (m:_Entity {repositoryId:$rid, entityType:'Module', inImportCycle:true}) RETURN m.label;

// whole-repo test-coverage gap — source files no test imports (Test→Module COVERS in-edge absent)
MATCH (m:_Entity {repositoryId:$rid, entityType:'Module'})
WHERE NOT (m)<-[:COVERS]-(:_Entity {entityType:'Test'}) RETURN m.label ORDER BY m.label;

// DEFINES bridge — every construct's defining file (file tier ↔ architectural tier)
MATCH (m:_Entity {repositoryId:$rid, entityType:'Module'})-[:DEFINES]->(c:_Entity)
RETURN c.entityType, c.label, m.label ORDER BY c.entityType, c.label;
```
