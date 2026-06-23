/**
 * Vocabulary for the deep-memory codebase architecture graph (Deep Memory / Neo4j).
 *
 * Models the cross-package seams of this monorepo — the layers where grep/LSP are weakest
 * and a graph traversal pays off:
 *   - Package        the 9 workspace packages + the external runtime/peer deps they pull in,
 *                    and the dependency edges between them (the monorepo wiring, and the basis
 *                    for the `core` zero-runtime-dependency invariant query).
 *   - ProviderContract / ProviderImpl  the pluggable-provider seam: each provider interface
 *                    (StorageProvider, SearchProvider, EmbeddingProvider, GraphTraversalProvider,
 *                    LockProvider, LLMProvider) and the concrete classes that IMPLEMENT it,
 *                    scattered across packages — "change this contract, which impls break?".
 *   - McpServer / McpTool  the two MCP servers (local memory + indexer) and the tools each one
 *                    ADVERTISES, with a `mutates` flag for read-only reasoning.
 *   - Doc / Test     markdown docs that DOCUMENTS/MENTIONS the modelled symbols, and co-located
 *                    tests that COVERS them.
 *
 * Every node and edge here is mined deterministically from source (package.json, `implements`
 * clauses, `get name()` literals, markdown links, test imports) — no LLM, no inference. The
 * intent/semantic layer (invariants, the "why", cross-runtime contracts) is a later, LLM-driven
 * iteration and is intentionally absent.
 *
 * Type names are chosen to clear Deep Memory's vocabulary similarity guard (Jaro-Winkler ≥ 0.85
 * rejects a near-duplicate): `ProviderContract` vs `ProviderImpl` scores 0.833, `McpServer` vs
 * `McpTool` 0.71 — both pass.
 */
import type { VocabularyInput } from '@utaba/deep-memory';

// Deep Memory requires a UUID repositoryId. Pinned (not generated) so every rebuild and the
// local MCP server target the same repository. Distinct from the UCM graph's id.
export const REPOSITORY_ID = 'd33c0de0-9a1b-4c2d-8e3f-1a2b3c4d5e6f';
export const REPOSITORY_LABEL = 'Deep Memory Codebase Architecture';

// Human-facing marker, recorded in repository metadata. Vocabulary changes are reconciled in
// place on every rebuild (add/edit/delete types) — this version no longer triggers a recreate.
export const VOCAB_VERSION = '1.0.0';

// Fixed namespace for deterministic (UUIDv5) entity ids derived from natural keys, so the same
// logical node maps to the same graph id across rebuilds — the basis for delta-write.
export const ID_NAMESPACE = '7d39c1a2-5b6c-4d7e-8f90-a1b2c3d4e5f6';

// Entity type names
export const ENTITY_PACKAGE = 'Package';
export const ENTITY_PROVIDER_CONTRACT = 'ProviderContract';
export const ENTITY_PROVIDER_IMPL = 'ProviderImpl';
export const ENTITY_MCP_SERVER = 'McpServer';
export const ENTITY_MCP_TOOL = 'McpTool';
export const ENTITY_DOC = 'Doc';
export const ENTITY_TEST = 'Test';
export const ENTITY_MODULE = 'Module'; // a non-test source file (file-level dependency layer)
export const ENTITY_ERROR_TYPE = 'ErrorType'; // an exported error class in the typed-error hierarchy

// Relationship type names (stored verbatim; Neo4j renders them uppercased)
export const REL_DEPENDS_ON_PACKAGE = 'DEPENDS_ON_PACKAGE'; // Package -> Package (package.json dep)
export const REL_IMPLEMENTS = 'IMPLEMENTS'; // ProviderImpl -> ProviderContract (implements clause)
export const REL_CONTAINS = 'CONTAINS'; // Package -> ProviderContract|ProviderImpl|McpServer|ErrorType
export const REL_ADVERTISES = 'ADVERTISES'; // McpServer -> McpTool (the server exposes the tool)
export const REL_DOCUMENTS = 'DOCUMENTS'; // Doc -> code symbol (markdown link to source file)
export const REL_MENTIONS = 'MENTIONS'; // Doc -> ProviderContract|ProviderImpl (symbol name in prose)
export const REL_COVERS = 'COVERS'; // Test -> ProviderImpl|ProviderContract|McpTool (test imports the symbol)
export const REL_IMPORTS = 'IMPORTS'; // Module -> Module|Package (import/export-from specifier)
export const REL_DESCRIBES = 'DESCRIBES'; // Doc -> Package (a package README documents its package)
export const REL_EXTENDS = 'EXTENDS'; // ErrorType -> ErrorType (subclass -> superclass)
export const REL_THROWS = 'THROWS'; // Module -> ErrorType (a file constructs/throws that error)

export const vocabulary: VocabularyInput = {
  entityTypes: [
    {
      type: ENTITY_PACKAGE,
      description:
        'A package in the dependency graph. The 9 workspace packages of this monorepo (isWorkspace=true) plus any external npm package they declare as a runtime or peer dependency (isWorkspace=false; external devDependencies are excluded as build-tooling noise). The label is the npm name. `core` (isCore=true, @utaba/deep-memory) must have zero outgoing runtime/peer DEPENDS_ON_PACKAGE edges — that absence IS the zero-runtime-dependency invariant.',
      properties: [
        { name: 'dir', type: 'string', required: false, description: 'Workspace directory relative to the repo root, e.g. packages/core. Absent for external packages.' },
        { name: 'isWorkspace', type: 'boolean', required: true, description: 'True for a monorepo workspace package; false for an external npm dependency.' },
        { name: 'isCore', type: 'boolean', required: true, description: 'True only for @utaba/deep-memory, the zero-runtime-dependency core package.' },
        { name: 'fingerprint', type: 'string', required: false, description: 'Internal content hash used for delta reconciliation.' },
      ],
    },
    {
      type: ENTITY_PROVIDER_CONTRACT,
      description:
        'A pluggable provider interface — the seam an implementation plugs into. Discovered as an `export interface *Provider` declaration: StorageProvider, SearchProvider, EmbeddingProvider, GraphTraversalProvider, LockProvider (packages/core/src/providers), and LLMProvider (packages/indexer/src/providers). The label is the interface name. A contract with no IMPLEMENTS in-edge has no implementation — a meaningful absence (e.g. LockProvider).',
      properties: [
        { name: 'filePath', type: 'string', required: true, description: 'Source file declaring the interface, relative to the repo root.' },
        { name: 'fingerprint', type: 'string', required: false, description: 'Internal content hash used for delta reconciliation.' },
      ],
    },
    {
      type: ENTITY_PROVIDER_IMPL,
      description:
        'A concrete provider implementation — a class that satisfies a provider contract either nominally (an `implements <*Provider>` clause, e.g. SqlServerStorageProvider, CosmosDbProvider, InMemoryStorageProvider, OpenAIEmbeddingProvider, AnthropicLLMProvider) or structurally (declares every required member of the contract without the clause, e.g. Neo4jStorageProvider, which defers its `implements` declaration). The label is the class name. It IMPLEMENTS one or more ProviderContracts (CosmosDbProvider and Neo4jStorageProvider each implement two), so "what breaks if I change this contract" is the contract\'s IMPLEMENTS in-edges. The `detection` property on each IMPLEMENTS edge says whether that edge was declared or inferred.',
      properties: [
        { name: 'filePath', type: 'string', required: true, description: 'Source file declaring the class, relative to the repo root.' },
        { name: 'fingerprint', type: 'string', required: false, description: 'Internal content hash used for delta reconciliation.' },
      ],
    },
    {
      type: ENTITY_MCP_SERVER,
      description:
        'An MCP server that advertises tools to an AI caller. Two exist: the local memory server (@utaba/deep-memory-local-mcp-server, memory_* tools) and the indexer server (@utaba/deep-memory-indexer-mcp-server, indexing_* tools). The label is the npm name; `kind` is the stable discriminator.',
      properties: [
        { name: 'kind', type: 'string', required: true, description: 'Stable server discriminator: memory | indexer.' },
        { name: 'transport', type: 'string', required: true, description: 'How callers reach it (stdio).' },
        { name: 'toolPrefix', type: 'string', required: false, description: 'Wire-name prefix of the tools it advertises, e.g. memory_ or indexing_.' },
        { name: 'filePath', type: 'string', required: true, description: 'Server entry point relative to the repo root.' },
        { name: 'fingerprint', type: 'string', required: false, description: 'Internal content hash used for delta reconciliation.' },
      ],
    },
    {
      type: ENTITY_MCP_TOOL,
      description:
        'A tool an AI caller can invoke, identified by its wire name (e.g. memory_create_entities, indexing_execute). Mined from each tool class\'s `get name()` literal. `mutates` flags write tools (create/update/delete/remove/import/ensure/reembed/propose/init/execute/stop) for read-only reasoning. The two servers expose disjoint tool sets, so each tool has exactly one ADVERTISES in-edge.',
      properties: [
        { name: 'domain', type: 'string', required: true, description: 'Functional grouping: for memory tools the tool subfolder (entity | relationship | repository | graph | search | stats | vocabulary | portability); for the indexer, indexing.' },
        { name: 'mutates', type: 'boolean', required: true, description: 'True if the tool writes/mutates state (its wire name matches create|update|delete|remove|import|ensure|reembed|propose|init|execute|stop).' },
        { name: 'className', type: 'string', required: false, description: 'Implementing class name, e.g. CreateEntitiesTool.' },
        { name: 'filePath', type: 'string', required: false, description: 'Source file declaring the tool class, relative to the repo root.' },
        { name: 'fingerprint', type: 'string', required: false, description: 'Internal content hash used for delta reconciliation.' },
      ],
    },
    {
      type: ENTITY_DOC,
      description:
        'A documentation file (docs/**/*.md, the root quickstart-*.md / README.md, and each package README). The label is the document title (first H1). It DOCUMENTS the source files it links to and MENTIONS the symbol names in its prose.',
      properties: [
        { name: 'filePath', type: 'string', required: true, description: 'Doc file path relative to the repo root.' },
        { name: 'fingerprint', type: 'string', required: false, description: 'Internal content hash used for delta reconciliation.' },
      ],
    },
    {
      type: ENTITY_TEST,
      description:
        'A co-located test file (packages/*/src/**/*.{test,spec}.ts). The label is the repo-relative path (filenames collide). It COVERS the ProviderImpl/ProviderContract symbols and McpTool classes it imports (imports-primary resolution). A static code fact — the symbol is imported — not proof of assertion depth; the value is "which tests touch what I changed" and the ABSENCE of edges (a modelled node no test covers — e.g. an untested MCP tool).',
      properties: [
        { name: 'filePath', type: 'string', required: true, description: 'Test file path relative to the repo root.' },
        { name: 'fingerprint', type: 'string', required: false, description: 'Internal content hash used for delta reconciliation.' },
      ],
    },
    {
      type: ENTITY_MODULE,
      description:
        'A non-test source file under packages/*/src (the file-level dependency layer beneath the package graph). The label is the repo-relative path. It IMPORTS other Modules (intra-repo, resolved file-to-file) and Packages (bare workspace/external imports), so "if I change this file, which files import it?" and "which files use neo4j-driver?" are one-hop queries — finer than DEPENDS_ON_PACKAGE. It THROWS the modelled ErrorTypes it constructs. `package` is the owning npm package (a property, not a CONTAINS edge — 186 modules would drown the package neighborhood). `throwsRawError` flags a file that throws an error not in the modelled typed hierarchy (the JS builtin Error, a private error) — a lead for the typed-errors convention.',
      properties: [
        { name: 'filePath', type: 'string', required: true, description: 'Source file path relative to the repo root.' },
        { name: 'package', type: 'string', required: false, description: 'Owning npm package name, derived from the path.' },
        { name: 'isBarrel', type: 'boolean', required: false, description: 'True for an index.ts barrel (mostly re-exports rather than definitions).' },
        { name: 'throwsRawError', type: 'boolean', required: false, description: 'True if the file throws an error constructor that is not a modelled ErrorType (e.g. the builtin Error) — a typed-error-convention lead.' },
        { name: 'fingerprint', type: 'string', required: false, description: 'Internal content hash used for delta reconciliation.' },
      ],
    },
    {
      type: ENTITY_ERROR_TYPE,
      description:
        'An exported error class in the typed-error hierarchy (a class whose `extends` base name ends in "Error", rooted at DeepMemoryError → builtin Error). The label is the class name. It EXTENDS its superclass (the catchability chain — catching DeepMemoryError catches every subclass) and is the target of Module THROWS edges ("which files throw this error?"). `extendsBuiltin` marks a root extending the JS builtin Error directly. Module-private errors are excluded by design.',
      properties: [
        { name: 'filePath', type: 'string', required: true, description: 'Source file declaring the class, relative to the repo root.' },
        { name: 'package', type: 'string', required: false, description: 'Owning npm package name, derived from the path.' },
        { name: 'extendsBuiltin', type: 'boolean', required: false, description: 'True when the class extends the JS builtin Error directly — a hierarchy root.' },
        { name: 'fingerprint', type: 'string', required: false, description: 'Internal content hash used for delta reconciliation.' },
      ],
    },
  ],
  relationshipTypes: [
    {
      type: REL_DEPENDS_ON_PACKAGE,
      description:
        'A package depends on another package, declared in its package.json. Workspace-internal edges cover dependency/peerDependency/devDependency; edges to external packages are created only for dependency/peerDependency (runtime + peer) — external devDependencies are omitted. The `depType` property records which. The security/architecture value is in the ABSENCE of runtime/peer out-edges from `core`.',
      allowedSourceTypes: [ENTITY_PACKAGE],
      allowedTargetTypes: [ENTITY_PACKAGE],
      properties: [
        { name: 'depType', type: 'string', required: false, description: 'The package.json field the dependency came from: dependency | peerDependency | devDependency.' },
        { name: 'disc', type: 'string', required: false, description: 'Internal discriminator (sorted property digest) for delta reconciliation of multi-edges between the same source and target.' },
      ],
    },
    {
      type: REL_IMPLEMENTS,
      description:
        'A provider implementation implements a provider contract. One edge per implemented contract — a class implementing two contracts has two. The `detection` property records how the edge was found: `nominal` (an explicit `implements <*Provider>` clause) or `structural` (the class declares every required member of the contract but omits the clause, e.g. Neo4jStorageProvider). Structural edges are inferred from the method surface, not declared — treat them as high-confidence but verify before relying on one.',
      allowedSourceTypes: [ENTITY_PROVIDER_IMPL],
      allowedTargetTypes: [ENTITY_PROVIDER_CONTRACT],
      properties: [
        { name: 'detection', type: 'string', required: false, description: 'How the implements relationship was discovered: nominal (explicit `implements` clause) | structural (full required-member conformance, no clause).' },
        { name: 'disc', type: 'string', required: false, description: 'Internal discriminator (sorted property digest) for delta reconciliation.' },
      ],
    },
    {
      type: REL_CONTAINS,
      description: 'A package contains a modelled architectural construct declared in its source — the provider contracts/impls it defines, the MCP server it ships, and the error types it declares. Anchors each construct to its owning package (derived from the file path). Note: Module nodes are deliberately NOT CONTAINS-anchored (186 of them would swamp the package neighborhood) — they carry a `package` property instead.',
      allowedSourceTypes: [ENTITY_PACKAGE],
      allowedTargetTypes: [ENTITY_PROVIDER_CONTRACT, ENTITY_PROVIDER_IMPL, ENTITY_MCP_SERVER, ENTITY_ERROR_TYPE],
    },
    {
      type: REL_ADVERTISES,
      description: 'An MCP server advertises a tool (the tool class is registered on that server). One edge per (server, tool).',
      allowedSourceTypes: [ENTITY_MCP_SERVER],
      allowedTargetTypes: [ENTITY_MCP_TOOL],
    },
    {
      type: REL_DOCUMENTS,
      description: 'A doc documents a code construct via an explicit markdown link to its source file (strong, precise).',
      allowedSourceTypes: [ENTITY_DOC],
      allowedTargetTypes: [ENTITY_PROVIDER_CONTRACT, ENTITY_PROVIDER_IMPL, ENTITY_MCP_SERVER, ENTITY_MCP_TOOL],
    },
    {
      type: REL_MENTIONS,
      description: 'A doc mentions a provider contract or implementation by symbol name in prose, without an explicit source link (soft, broader). Suppressed where a stronger DOCUMENTS edge to the same target already exists from that doc.',
      allowedSourceTypes: [ENTITY_DOC],
      allowedTargetTypes: [ENTITY_PROVIDER_CONTRACT, ENTITY_PROVIDER_IMPL],
    },
    {
      type: REL_COVERS,
      description:
        'A test file covers a provider implementation/contract or an MCP tool — it imports the modelled symbol (the impl/contract interface by name, or the tool by its implementing class name, e.g. FindEntitiesTool → memory_find_entities). Imports-primary: resolution is by import declaration, so non-modelled imports (vitest, helpers, types) are dropped. The `role` property separates the test\'s subject (the symbol matching the test filename, e.g. CosmosDbProvider.test.ts → CosmosDbProvider) from a fixture (a symbol merely imported as scaffolding, e.g. InMemoryStorageProvider in a tool test) — so "tests that actually target X" filters on role=subject, cutting the universal-fixture noise. A static code fact, not proof of assertion depth; the value is also in the ABSENCE of an in-edge (e.g. an McpTool no test covers).',
      allowedSourceTypes: [ENTITY_TEST],
      allowedTargetTypes: [ENTITY_PROVIDER_IMPL, ENTITY_PROVIDER_CONTRACT, ENTITY_MCP_TOOL],
      properties: [
        { name: 'role', type: 'string', required: false, description: 'subject (the symbol matches the test filename — the unit under test) | fixture (imported as scaffolding).' },
        { name: 'disc', type: 'string', required: false, description: 'Internal discriminator (sorted property digest) for delta reconciliation.' },
      ],
    },
    {
      type: REL_IMPORTS,
      description:
        'A source file imports (or re-exports) from another module or a package. Module → Module is intra-repo, resolved file-to-file (ESM `.js` specifiers mapped back to `.ts`, bare dirs to index.ts) — the file-level blast radius DEPENDS_ON_PACKAGE can\'t give. Module → Package is a bare workspace/external import, so "which files import @utaba/deep-memory / neo4j-driver" is one hop. Includes type-only imports (a type change still ripples). Imports of unmodelled packages (node builtins, untracked npm) are dropped.',
      allowedSourceTypes: [ENTITY_MODULE],
      allowedTargetTypes: [ENTITY_MODULE, ENTITY_PACKAGE],
    },
    {
      type: REL_DESCRIBES,
      description: 'A package README documents its own package (Doc → Package). The strong, reliable doc↔package link that DOCUMENTS (which needs a markdown link to a .ts file) is too sparse to provide — "which doc explains package X" in one hop.',
      allowedSourceTypes: [ENTITY_DOC],
      allowedTargetTypes: [ENTITY_PACKAGE],
    },
    {
      type: REL_EXTENDS,
      description: 'An error type extends its superclass (ErrorType → ErrorType), the catchability chain: catching a base (e.g. DeepMemoryError) catches every transitive subclass. A root that extends the JS builtin Error has no out-edge and is marked `extendsBuiltin` on the node.',
      allowedSourceTypes: [ENTITY_ERROR_TYPE],
      allowedTargetTypes: [ENTITY_ERROR_TYPE],
    },
    {
      type: REL_THROWS,
      description: 'A source file constructs and throws an error type (Module → ErrorType, from a `throw new XError(...)` site). Answers "which files throw this error?" / "what can this file throw?". Throws of an unmodelled error (the builtin Error, a private error) are not edges — they set the source Module\'s `throwsRawError` flag instead.',
      allowedSourceTypes: [ENTITY_MODULE],
      allowedTargetTypes: [ENTITY_ERROR_TYPE],
    },
  ],
};
