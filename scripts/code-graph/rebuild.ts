/**
 * code-graph — build/refresh the deep-memory codebase architecture graph in Neo4j via Deep Memory.
 *
 * Scope: the cross-package seams (the layers grep/LSP answer poorly). Mines source
 * deterministically (no LLM, NO embeddings — zero API cost) and writes:
 *     (Package)-[:DEPENDS_ON_PACKAGE]->(Package)       from each package.json
 *     (ProviderImpl)-[:IMPLEMENTS]->(ProviderContract)  from `implements *Provider` clauses
 *     (Package)-[:CONTAINS]->(ProviderContract|ProviderImpl|McpServer)
 *     (McpServer)-[:ADVERTISES]->(McpTool)              from each tool's `get name()` literal
 *     (Doc)-[:DOCUMENTS]->(code)                        markdown links to source files
 *     (Doc)-[:MENTIONS]->(ProviderContract|ProviderImpl) symbol names in prose
 *     (Test)-[:COVERS]->(ProviderImpl|ProviderContract) co-located test imports
 *
 * Delta-write via desired-state reconciliation (NOT git-diff): re-extract the full desired
 * graph, read current state from Neo4j, diff (create/update/delete/skip), apply only the
 * difference. Deterministic UUIDv5 ids + per-node fingerprints make it idempotent and
 * self-healing. The vocabulary evolves in place (no destructive recreate).
 *
 * NO embedding provider is configured: EntityManager.generateEmbedding() short-circuits when
 * `this.embedding` is unset, so entity writes compute no vectors and cost nothing. The graph is
 * navigated by slug / type / traversal; semantic search (memory_search_by_concept) is disabled
 * for this repo by design.
 *
 * Connection defaults match deep-memory's docker-compose.neo4j.yml; override via
 * NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD / NEO4J_DATABASE (or the DEEP_MEMORY_NEO4J_* names).
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { v5 as uuidv5 } from 'uuid';
import { DeepMemory, RepositoryNotFoundError } from '@utaba/deep-memory';
import type {
  CreateEntityInput,
  CreateRelationshipInput,
  MemoryRepository,
  StoredRepository,
  VocabularyInput,
  VocabularyProposal,
  PropertySchema,
} from '@utaba/deep-memory';
import { Neo4jStorageProvider } from '@utaba/deep-memory-storage-neo4j';
import { extractPackages } from './extract-packages';
import { extractProviders } from './extract-providers';
import { extractTools } from './extract-tools';
import { extractDocs } from './extract-docs';
import { extractTests } from './extract-tests';
import { extractModules } from './extract-modules';
import { extractErrors } from './extract-errors';
import {
  REPOSITORY_ID,
  REPOSITORY_LABEL,
  VOCAB_VERSION,
  ID_NAMESPACE,
  vocabulary,
  ENTITY_PACKAGE,
  ENTITY_PROVIDER_CONTRACT,
  ENTITY_PROVIDER_IMPL,
  ENTITY_MCP_SERVER,
  ENTITY_MCP_TOOL,
  ENTITY_DOC,
  ENTITY_TEST,
  ENTITY_MODULE,
  ENTITY_ERROR_TYPE,
  REL_DEPENDS_ON_PACKAGE,
  REL_IMPLEMENTS,
  REL_CONTAINS,
  REL_ADVERTISES,
  REL_DOCUMENTS,
  REL_MENTIONS,
  REL_COVERS,
  REL_IMPORTS,
  REL_DESCRIBES,
  REL_EXTENDS,
  REL_THROWS,
} from './vocabulary';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORE_PACKAGE = '@utaba/deep-memory';

const NEO4J_CONFIG = {
  uri: process.env.NEO4J_URI ?? process.env.DEEP_MEMORY_NEO4J_URI ?? 'bolt://localhost:7687',
  username: process.env.NEO4J_USERNAME ?? process.env.DEEP_MEMORY_NEO4J_USERNAME ?? 'neo4j',
  password: process.env.NEO4J_PASSWORD ?? process.env.DEEP_MEMORY_NEO4J_PASSWORD ?? 'DeepMem-Dev-1234',
  database: process.env.NEO4J_DATABASE ?? process.env.DEEP_MEMORY_NEO4J_DATABASE ?? 'neo4j',
};

// The two MCP servers — fixed, anchored to their packages via CONTAINS.
const MCP_SERVERS = [
  { kind: 'memory', npmName: '@utaba/deep-memory-local-mcp-server', dir: 'packages/mcp-server', filePath: 'packages/mcp-server/src/index.ts', toolPrefix: 'memory_' },
  { kind: 'indexer', npmName: '@utaba/deep-memory-indexer-mcp-server', dir: 'packages/indexer-mcp-server', filePath: 'packages/indexer-mcp-server/src/index.ts', toolPrefix: 'indexing_' },
] as const;

const sha1 = (value: string): string => createHash('sha1').update(value).digest('hex');
const idForKey = (naturalKey: string): string => uuidv5(naturalKey, ID_NAMESPACE);

/** Build provenance from git, so the stored graph records the commit/tree it reflects (it can go
 *  stale — the doc says so — but now you can tell HOW stale, and against which commit). Best-effort:
 *  any git failure degrades to nulls rather than aborting the rebuild. */
function gitProvenance(): { commit: string | null; branch: string | null; dirty: boolean | null } {
  const run = (args: string[]): string | null => {
    try {
      return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  const commit = run(['rev-parse', '--short', 'HEAD']);
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = run(['status', '--porcelain']);
  return { commit, branch, dirty: status === null ? null : status.length > 0 };
}

interface DesiredEntity {
  input: CreateEntityInput;
  fingerprint: string;
}

// ─── In-place vocabulary evolution (verbatim from the proven UCM machinery) ───────────────
const sortedEq = (a: string[] = [], b: string[] = []): boolean =>
  a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

const propEqual = (a: PropertySchema, b: PropertySchema): boolean =>
  a.type === b.type &&
  (a.required ?? false) === (b.required ?? false) &&
  (a.description ?? '') === (b.description ?? '') &&
  (a.enumValues ?? []).join('|') === (b.enumValues ?? []).join('|');

function diffProps(desired: PropertySchema[] = [], stored: PropertySchema[] = []): { add: PropertySchema[]; remove: string[]; update: PropertySchema[] } {
  const storedByName = new Map(stored.map((p) => [p.name, p]));
  const desiredNames = new Set(desired.map((p) => p.name));
  const add: PropertySchema[] = [];
  const update: PropertySchema[] = [];
  for (const p of desired) {
    const cur = storedByName.get(p.name);
    if (!cur) add.push(p);
    else if (!propEqual(p, cur)) update.push(p);
  }
  const remove = stored.filter((p) => !desiredNames.has(p.name)).map((p) => p.name);
  return { add, remove, update };
}

/** Converge the stored vocabulary to the desired one in place (no recreate). Throws on any
 *  proposal that isn't auto-approved, so a governance surprise can't pass silently. */
async function reconcileVocabulary(repo: MemoryRepository, desired: VocabularyInput): Promise<void> {
  const stored = (await repo.getVocabulary()).vocabulary;
  const storedEntityByType = new Map(stored.entityTypes.map((t) => [t.type, t]));
  const storedRelByType = new Map(stored.relationshipTypes.map((t) => [t.type, t]));
  const desiredEntityTypes = new Set((desired.entityTypes ?? []).map((t) => t.type));
  const desiredRelTypes = new Set((desired.relationshipTypes ?? []).map((t) => t.type));

  const proposals: VocabularyProposal[] = [];

  for (const et of desired.entityTypes ?? []) {
    const cur = storedEntityByType.get(et.type);
    if (!cur) {
      proposals.push({
        proposalType: 'entity_type',
        entityType: { type: et.type, description: et.description, properties: et.properties },
        justification: `code-graph — add entity type ${et.type}`,
      });
      continue;
    }
    const { add, remove, update } = diffProps(et.properties, cur.properties);
    const descChanged = (et.description ?? '') !== (cur.description ?? '');
    if (descChanged || add.length || remove.length || update.length) {
      proposals.push({
        proposalType: 'edit_entity_type',
        editEntityType: {
          type: et.type,
          description: descChanged ? et.description : undefined,
          addProperties: add.length ? add : undefined,
          removeProperties: remove.length ? remove : undefined,
          updateProperties: update.length ? update : undefined,
        },
        justification: `code-graph — edit entity type ${et.type}`,
      });
    }
  }

  for (const rt of desired.relationshipTypes ?? []) {
    const cur = storedRelByType.get(rt.type);
    if (!cur) {
      proposals.push({
        proposalType: 'relationship_type',
        relationshipType: {
          type: rt.type,
          description: rt.description,
          allowedSourceTypes: rt.allowedSourceTypes,
          allowedTargetTypes: rt.allowedTargetTypes,
          properties: rt.properties,
        },
        justification: `code-graph — add relationship type ${rt.type}`,
      });
      continue;
    }
    const srcChanged = !sortedEq(rt.allowedSourceTypes, cur.allowedSourceTypes);
    const tgtChanged = !sortedEq(rt.allowedTargetTypes, cur.allowedTargetTypes);
    const descChanged = (rt.description ?? '') !== (cur.description ?? '');
    const { add, remove, update } = diffProps(rt.properties, cur.properties);
    if (srcChanged || tgtChanged || descChanged || add.length || remove.length || update.length) {
      proposals.push({
        proposalType: 'edit_relationship_type',
        editRelationshipType: {
          type: rt.type,
          description: descChanged ? rt.description : undefined,
          allowedSourceTypes: srcChanged ? rt.allowedSourceTypes : undefined,
          allowedTargetTypes: tgtChanged ? rt.allowedTargetTypes : undefined,
          addProperties: add.length ? add : undefined,
          removeProperties: remove.length ? remove : undefined,
          updateProperties: update.length ? update : undefined,
        },
        justification: `code-graph — edit relationship type ${rt.type}`,
      });
    }
  }

  for (const t of stored.relationshipTypes) {
    if (!desiredRelTypes.has(t.type)) {
      proposals.push({ proposalType: 'delete_relationship_type', deleteRelationshipType: { type: t.type }, justification: `code-graph — remove relationship type ${t.type}` });
    }
  }
  for (const t of stored.entityTypes) {
    if (!desiredEntityTypes.has(t.type)) {
      proposals.push({ proposalType: 'delete_entity_type', deleteEntityType: { type: t.type }, justification: `code-graph — remove entity type ${t.type}` });
    }
  }

  if (proposals.length === 0) {
    console.log('[code-graph] vocabulary in sync (0 changes)');
    return;
  }

  for (const proposal of proposals) {
    if (proposal.proposalType.startsWith('delete_')) {
      const name = proposal.deleteRelationshipType?.type ?? proposal.deleteEntityType?.type;
      console.warn(`[code-graph] vocab DELETE ${proposal.proposalType.replace('delete_', '')} '${name}' — cascade-deletes its data`);
    }
    const result = await repo.proposeVocabularyChange(proposal);
    if (result.status !== 'approved') {
      throw new Error(
        `[code-graph] vocabulary change '${result.type}' (${proposal.proposalType}) not applied: status=${result.status}` +
          `${result.reason ? `; reason=${result.reason}` : ''}`,
      );
    }
    console.log(`[code-graph] vocab ${proposal.proposalType} '${result.type}' applied (vocab v${result.vocabularyVersion ?? '?'})`);
  }
}

async function main(): Promise<void> {
  // Skip in CI: local dev tooling backed by a local Neo4j that pipelines can't reach.
  if (process.env.CI) {
    console.log('[code-graph] CI detected — skipping.');
    return;
  }
  console.log(`[code-graph] repo root: ${REPO_ROOT}`);

  // 1. Extract the desired graph from the working tree (deterministic, cheap).
  const packages = extractPackages(REPO_ROOT);
  const { contracts, impls } = extractProviders(REPO_ROOT);
  const tools = extractTools(REPO_ROOT);
  const docs = extractDocs(REPO_ROOT);
  const tests = extractTests(REPO_ROOT);
  const modules = extractModules(REPO_ROOT);
  const errorTypes = extractErrors(REPO_ROOT);
  console.log(
    `[code-graph] extracted ${packages.length} packages, ${contracts.length} contracts, ${impls.length} impls, ${tools.length} tools, ${docs.length} docs, ${tests.length} tests, ${modules.length} modules, ${errorTypes.length} error types`,
  );

  // 2. Build the desired entity set (deterministic ids + fingerprints).
  const desiredEntities = new Map<string, DesiredEntity>();
  const ensureEntity = (
    naturalKey: string,
    build: () => { entityType: string; label: string; summary?: string; properties?: Record<string, unknown> },
    fingerprintSource: string,
  ): string => {
    const id = idForKey(naturalKey);
    if (desiredEntities.has(id)) return id;
    const base = build();
    const fingerprint = sha1(fingerprintSource);
    desiredEntities.set(id, {
      fingerprint,
      input: { id, entityType: base.entityType, label: base.label, summary: base.summary, properties: { ...(base.properties ?? {}), fingerprint } },
    });
    return id;
  };

  // 3. Build the desired edge set (keyed by type|source|target[|disc], deduped).
  const desiredEdges = new Map<string, CreateRelationshipInput>();
  const edgeDisc = (properties: Record<string, unknown>): string =>
    Object.keys(properties).sort().map((k) => `${k}=${properties[k] ?? ''}`).join('&');
  const addEdge = (relationshipType: string, sourceEntityId: string, targetEntityId: string, properties?: Record<string, unknown>): void => {
    if (sourceEntityId === targetEntityId) return;
    let key = `${relationshipType}|${sourceEntityId}|${targetEntityId}`;
    let edgeProps: Record<string, unknown> | undefined;
    if (properties) {
      const disc = edgeDisc(properties);
      key += `|${disc}`;
      edgeProps = { ...properties, disc };
    }
    if (!desiredEdges.has(key)) {
      desiredEdges.set(key, { relationshipType, sourceEntityId, targetEntityId, ...(edgeProps ? { properties: edgeProps } : {}) });
    }
  };

  // ── Packages + the package dependency graph ──────────────────────────────
  const workspaceNames = new Set(packages.map((p) => p.name));
  const packageIdByName = new Map<string, string>();
  const packageIdByDir = new Map<string, string>();
  const ensurePackage = (name: string, isWorkspace: boolean, dir?: string): string => {
    const isCore = name === CORE_PACKAGE;
    const props: Record<string, unknown> = { isWorkspace, isCore };
    if (dir) props.dir = dir;
    const id = ensureEntity(
      `package:${name}`,
      () => ({ entityType: ENTITY_PACKAGE, label: name, properties: props }),
      [ENTITY_PACKAGE, name, String(isWorkspace), String(isCore), dir ?? ''].join(''),
    );
    packageIdByName.set(name, id);
    if (dir) packageIdByDir.set(dir, id);
    return id;
  };
  for (const p of packages) ensurePackage(p.name, true, p.dir);
  for (const p of packages) {
    const srcId = packageIdByName.get(p.name)!;
    for (const dep of p.deps) {
      const isWorkspace = workspaceNames.has(dep.name);
      // External devDependencies are build-tooling noise — only runtime/peer external deps matter.
      if (!isWorkspace && dep.depType === 'devDependency') continue;
      const tgtId = isWorkspace ? packageIdByName.get(dep.name)! : ensurePackage(dep.name, false);
      addEdge(REL_DEPENDS_ON_PACKAGE, srcId, tgtId, { depType: dep.depType });
    }
  }

  // Owning package for a source file at packages/<dir>/… (the first two path segments).
  const ownerPackageId = (filePath: string): string | undefined => {
    const parts = filePath.split(path.sep);
    if (parts[0] !== 'packages' || parts.length < 2) return undefined;
    return packageIdByDir.get(`packages${path.sep}${parts[1]}`) ?? packageIdByDir.get(`packages/${parts[1]}`);
  };
  // Owning package NAME for a source file (the property carried by Module / ErrorType nodes).
  const packageNameByDir = new Map(packages.map((p) => [p.dir, p.name]));
  const ownerPackageName = (filePath: string): string | undefined => {
    const parts = filePath.split(path.sep);
    if (parts[0] !== 'packages' || parts.length < 2) return undefined;
    return packageNameByDir.get(`packages${path.sep}${parts[1]}`) ?? packageNameByDir.get(`packages/${parts[1]}`);
  };

  // ── Provider contracts + impls ───────────────────────────────────────────
  const contractIdByName = new Map<string, string>();
  for (const c of contracts) {
    const id = ensureEntity(
      `contract:${c.name}`,
      () => ({ entityType: ENTITY_PROVIDER_CONTRACT, label: c.name, properties: { filePath: c.filePath } }),
      [ENTITY_PROVIDER_CONTRACT, c.name, c.filePath].join(''),
    );
    contractIdByName.set(c.name, id);
    const owner = ownerPackageId(c.filePath);
    if (owner) addEdge(REL_CONTAINS, owner, id);
  }

  const implIdByClassName = new Map<string, string>();
  const unresolvedImplContracts: string[] = [];
  const structuralImpls: string[] = [];
  for (const im of impls) {
    // Detection is part of the fingerprint: if a structural edge later becomes a declared one,
    // the node re-reconciles instead of silently keeping the stale provenance.
    const contractFingerprint = im.contracts.map((c) => `${c.name}:${c.detection}`).sort().join(',');
    const id = ensureEntity(
      `impl:${im.className}`,
      () => ({ entityType: ENTITY_PROVIDER_IMPL, label: im.className, properties: { filePath: im.filePath } }),
      [ENTITY_PROVIDER_IMPL, im.className, im.filePath, contractFingerprint].join(''),
    );
    implIdByClassName.set(im.className, id);
    const owner = ownerPackageId(im.filePath);
    if (owner) addEdge(REL_CONTAINS, owner, id);
    for (const contract of im.contracts) {
      const contractId = contractIdByName.get(contract.name);
      if (!contractId) {
        unresolvedImplContracts.push(`${im.className} -> ${contract.name}`);
        continue;
      }
      addEdge(REL_IMPLEMENTS, id, contractId, { detection: contract.detection });
      if (contract.detection === 'structural') structuralImpls.push(`${im.className} -> ${contract.name}`);
    }
  }

  // ── MCP servers + tools ──────────────────────────────────────────────────
  const serverIdByKind = new Map<string, string>();
  for (const s of MCP_SERVERS) {
    const id = ensureEntity(
      `mcpserver:${s.kind}`,
      () => ({ entityType: ENTITY_MCP_SERVER, label: s.npmName, properties: { kind: s.kind, transport: 'stdio', toolPrefix: s.toolPrefix, filePath: s.filePath } }),
      [ENTITY_MCP_SERVER, s.kind, s.npmName, s.filePath, s.toolPrefix].join(''),
    );
    serverIdByKind.set(s.kind, id);
    const owner = packageIdByDir.get(s.dir);
    if (owner) addEdge(REL_CONTAINS, owner, id);
  }

  // Repo-relative source path -> entity id, for Doc DOCUMENTS links (any modelled file-backed node).
  const sourceEntityIdByFilePath = new Map<string, string>();
  for (const c of contracts) sourceEntityIdByFilePath.set(c.filePath, contractIdByName.get(c.name)!);
  for (const im of impls) sourceEntityIdByFilePath.set(im.filePath, implIdByClassName.get(im.className)!);
  for (const s of MCP_SERVERS) sourceEntityIdByFilePath.set(s.filePath, serverIdByKind.get(s.kind)!);

  // Tool implementing-class name -> tool id, for Test COVERS (a tool test imports the tool class).
  const toolIdByClassName = new Map<string, string>();
  for (const t of tools) {
    const toolId = ensureEntity(
      `mcptool:${t.wireName}`,
      () => ({ entityType: ENTITY_MCP_TOOL, label: t.wireName, properties: { domain: t.domain, mutates: t.mutates, className: t.className, filePath: t.filePath } }),
      [ENTITY_MCP_TOOL, t.wireName, t.domain, String(t.mutates), t.className, t.filePath].join(''),
    );
    sourceEntityIdByFilePath.set(t.filePath, toolId);
    if (t.className) toolIdByClassName.set(t.className, toolId);
    const serverId = serverIdByKind.get(t.server);
    if (serverId) addEdge(REL_ADVERTISES, serverId, toolId);
  }

  // Symbol label -> id, for Doc MENTIONS and Test COVERS (contracts + impls).
  const contractOrImplIdByLabel = new Map<string, string>();
  for (const [name, id] of contractIdByName) contractOrImplIdByLabel.set(name, id);
  for (const [name, id] of implIdByClassName) contractOrImplIdByLabel.set(name, id);

  // A package's README path -> that package's id, for the Doc DESCRIBES Package edge.
  const packageIdByReadme = new Map<string, string>();
  for (const p of packages) {
    const id = packageIdByName.get(p.name);
    if (id) packageIdByReadme.set(`${p.dir}${path.sep}README.md`, id);
  }

  // ── Docs ─────────────────────────────────────────────────────────────────
  for (const d of docs) {
    const docId = ensureEntity(
      `doc:${d.filePath}`,
      () => ({ entityType: ENTITY_DOC, label: d.title, properties: { filePath: d.filePath } }),
      [ENTITY_DOC, d.title, d.filePath].join(''),
    );
    // A package README describes its package — the strong doc↔package link DOCUMENTS can't give.
    const describedPackageId = packageIdByReadme.get(d.filePath) ?? packageIdByReadme.get(d.filePath.split('/').join(path.sep));
    if (describedPackageId) addEdge(REL_DESCRIBES, docId, describedPackageId);
    const documentedTargets = new Set<string>();
    for (const linked of d.linkedPaths) {
      const targetId = sourceEntityIdByFilePath.get(linked);
      if (!targetId) continue; // links to non-modelled files are dropped
      addEdge(REL_DOCUMENTS, docId, targetId);
      documentedTargets.add(targetId);
    }
    for (const sym of d.mentionedSymbols) {
      const targetId = contractOrImplIdByLabel.get(sym);
      if (!targetId || documentedTargets.has(targetId)) continue; // suppressed where DOCUMENTS already links
      addEdge(REL_MENTIONS, docId, targetId);
    }
  }

  // ── Tests ──────────────────────────────────────────────────────────────────
  const uncoveredTests: string[] = [];
  for (const t of tests) {
    const testId = ensureEntity(
      `test:${t.filePath}`,
      () => ({ entityType: ENTITY_TEST, label: t.filePath, properties: { filePath: t.filePath } }),
      [ENTITY_TEST, t.filePath].join(''),
    );
    // The symbol matching the filename is the unit under test (subject); the rest are fixtures.
    const subject = path.basename(t.filePath).replace(/\.(test|spec)\.ts$/, '');
    let covered = 0;
    for (const sym of t.importedSymbols) {
      // A test covers a provider contract/impl (imported by interface/class name) or an MCP tool
      // (imported by its implementing class name, e.g. FindEntitiesTool → memory_find_entities).
      const targetId = contractOrImplIdByLabel.get(sym) ?? toolIdByClassName.get(sym);
      if (!targetId) continue; // non-modelled import — dropped, like DOCUMENTS
      addEdge(REL_COVERS, testId, targetId, { role: sym === subject ? 'subject' : 'fixture' });
      covered++;
    }
    if (covered === 0) uncoveredTests.push(t.filePath);
  }

  // ── Error types + the catchability hierarchy ─────────────────────────────────
  const errorIdByClassName = new Map<string, string>();
  for (const e of errorTypes) {
    const pkg = ownerPackageName(e.filePath);
    const id = ensureEntity(
      `error:${e.className}`,
      () => ({ entityType: ENTITY_ERROR_TYPE, label: e.className, properties: { filePath: e.filePath, ...(pkg ? { package: pkg } : {}), extendsBuiltin: e.extendsBuiltin } }),
      [ENTITY_ERROR_TYPE, e.className, e.filePath, pkg ?? '', String(e.extendsBuiltin)].join(''),
    );
    errorIdByClassName.set(e.className, id);
    const owner = ownerPackageId(e.filePath);
    if (owner) addEdge(REL_CONTAINS, owner, id);
  }
  for (const e of errorTypes) {
    if (e.extendsBuiltin) continue; // root: extends the JS builtin Error, which is not a node
    const childId = errorIdByClassName.get(e.className);
    const parentId = errorIdByClassName.get(e.extendsName);
    if (childId && parentId) addEdge(REL_EXTENDS, childId, parentId);
  }

  // ── Modules + the file-level import graph ────────────────────────────────────
  // Pass 1: create every module node (and its THROWS edges); collect ids for intra-repo resolution.
  const moduleIdByFilePath = new Map<string, string>();
  const rawErrorModules: string[] = [];
  for (const m of modules) {
    const pkg = ownerPackageName(m.filePath);
    const throwsRawError = m.throwsErrorCtors.some((ctor) => !errorIdByClassName.has(ctor));
    const id = ensureEntity(
      `module:${m.filePath}`,
      () => ({ entityType: ENTITY_MODULE, label: m.filePath, properties: { filePath: m.filePath, ...(pkg ? { package: pkg } : {}), isBarrel: m.isBarrel, throwsRawError } }),
      [ENTITY_MODULE, m.filePath, pkg ?? '', String(m.isBarrel), String(throwsRawError)].join(''),
    );
    moduleIdByFilePath.set(m.filePath, id);
    if (throwsRawError) rawErrorModules.push(m.filePath);
    for (const ctor of m.throwsErrorCtors) {
      const errorId = errorIdByClassName.get(ctor);
      if (errorId) addEdge(REL_THROWS, id, errorId);
    }
  }
  // Pass 2: import edges (needs all module ids resolved first).
  for (const m of modules) {
    const srcId = moduleIdByFilePath.get(m.filePath)!;
    for (const target of m.importsModules) {
      const tgtId = moduleIdByFilePath.get(target);
      if (tgtId) addEdge(REL_IMPORTS, srcId, tgtId);
    }
    for (const pkgName of m.importsPackages) {
      const tgtId = packageIdByName.get(pkgName);
      if (tgtId) addEdge(REL_IMPORTS, srcId, tgtId); // bare workspace/external import; unmodelled dropped
    }
  }

  if (unresolvedImplContracts.length) {
    console.warn(`[code-graph] ${unresolvedImplContracts.length} impl→contract refs unresolved (contract not found as an exported *Provider interface):`);
    for (const u of unresolvedImplContracts) console.warn(`  ${u}`);
  }
  if (structuralImpls.length) {
    console.log(`[code-graph] ${structuralImpls.length} IMPLEMENTS edge(s) inferred structurally (class declares the full required surface but omits the \`implements\` clause):`);
    for (const s of structuralImpls) console.log(`  ${s}`);
  }
  if (uncoveredTests.length) {
    console.log(`[code-graph] ${uncoveredTests.length} test files import no modelled symbol (expected for non-provider, non-tool tests).`);
  }
  if (rawErrorModules.length) {
    console.log(`[code-graph] ${rawErrorModules.length} modules throw an error outside the modelled typed hierarchy (Module.throwsRawError=true) — leads for the typed-errors convention.`);
  }

  // Build provenance: the commit/branch/dirty state the graph reflects (best-effort; nulls if no git).
  const provenance = gitProvenance();
  const builtAt = new Date().toISOString();

  // 4. Connect to Neo4j via the Deep Memory provider. NO embedding provider → zero embedding cost.
  const provider = new Neo4jStorageProvider(NEO4J_CONFIG);
  await provider.initialize();
  await provider.ensureSchema();

  const memory = new DeepMemory({
    storage: provider,
    graphTraversal: provider,
    provenance: { actorId: 'code-graph', actorType: 'agent' },
  });

  try {
    // 5. Resolve the repository. Create on first run; otherwise open and evolve vocabulary in place.
    let stored: StoredRepository | null = null;
    try {
      stored = await memory.getRepository(REPOSITORY_ID);
    } catch (error) {
      if (!(error instanceof RepositoryNotFoundError)) throw error;
    }

    let repo: MemoryRepository;
    if (!stored) {
      repo = await memory.createRepository({
        repositoryId: REPOSITORY_ID,
        label: REPOSITORY_LABEL,
        description: 'Derived architecture graph of the deep-memory monorepo (packages, providers, MCP tools, docs, tests). Rebuilt by `pnpm code-graph:rebuild`. No embeddings.',
        vocabulary,
        governance: { mode: 'managed' },
        metadata: { vocabVersion: VOCAB_VERSION, gitCommit: provenance.commit, gitBranch: provenance.branch, gitDirty: provenance.dirty, builtAt },
      });
      console.log('[code-graph] created repository (fresh)');
    } else {
      repo = await memory.openRepository(REPOSITORY_ID);
      await reconcileVocabulary(repo, vocabulary);
    }

    // 6. Read current graph state (ids + fingerprints, edge ids + endpoints).
    const currentEntityRows = (await repo.executeNativeQuery(
      'MATCH (n:_Entity) WHERE n.repositoryId = $rid RETURN n.id AS id, n.fingerprint AS fingerprint',
      { rid: REPOSITORY_ID },
    )) as Array<{ id: string; fingerprint: string | null }>;
    const currentFingerprintById = new Map(currentEntityRows.map((r) => [r.id, r.fingerprint]));

    const currentEdgeRows = (await repo.executeNativeQuery(
      'MATCH (s:_Entity)-[r]->(t:_Entity) WHERE r.repositoryId = $rid RETURN r.id AS id, type(r) AS type, s.id AS source, t.id AS target, r.properties AS props',
      { rid: REPOSITORY_ID },
    )) as Array<{ id: string; type: string; source: string; target: string; props: string | null }>;
    const discOf = (props: string | null): string | null => {
      if (!props) return null;
      try {
        return (JSON.parse(props) as { disc?: string }).disc ?? null;
      } catch {
        return null;
      }
    };
    const edgeKey = (type: string, source: string, target: string, disc: string | null): string =>
      `${type}|${source}|${target}${disc ? `|${disc}` : ''}`;
    const currentEdgeIdByKey = new Map(currentEdgeRows.map((r) => [edgeKey(r.type, r.source, r.target, discOf(r.props)), r.id]));

    // 7. Diff desired vs current.
    const toCreate: CreateEntityInput[] = [];
    const toUpdate: CreateEntityInput[] = [];
    for (const [id, desired] of desiredEntities) {
      if (!currentFingerprintById.has(id)) toCreate.push(desired.input);
      else if (currentFingerprintById.get(id) !== desired.fingerprint) toUpdate.push(desired.input);
    }
    const toDeleteEntityIds = currentEntityRows.map((r) => r.id).filter((id) => !desiredEntities.has(id));

    const toCreateEdges: CreateRelationshipInput[] = [];
    for (const [key, edge] of desiredEdges) if (!currentEdgeIdByKey.has(key)) toCreateEdges.push(edge);
    const toDeleteEdgeIds = currentEdgeRows
      .filter((r) => !desiredEdges.has(edgeKey(r.type, r.source, r.target, discOf(r.props))))
      .map((r) => r.id);

    const unchanged = desiredEntities.size - toCreate.length - toUpdate.length;
    console.log(`[code-graph] entities  +${toCreate.length} ~${toUpdate.length} -${toDeleteEntityIds.length} (=${unchanged} unchanged)`);
    console.log(`[code-graph] relationships  +${toCreateEdges.length} -${toDeleteEdgeIds.length}`);

    // 8. Apply the difference. Order: create/update endpoints → reconcile edges → delete entities.
    if (toCreate.length) await repo.createEntities(toCreate);
    for (const entity of toUpdate) {
      await repo.updateEntity(entity.id!, { summary: entity.summary ?? null, properties: { ...(entity.properties ?? {}) } });
    }
    if (toDeleteEdgeIds.length) await repo.removeRelationships(toDeleteEdgeIds);
    if (toCreateEdges.length) await repo.createRelationships(toCreateEdges);
    if (toDeleteEntityIds.length) await repo.deleteEntities(toDeleteEntityIds);

    // Refresh stored metadata (vocab marker + build provenance) only when something actually moved,
    // preserving the "a no-op rebuild writes nothing" property.
    if (stored) {
      const meta: Record<string, unknown> = stored.metadata ?? {};
      const graphChanged = !!(toCreate.length || toUpdate.length || toDeleteEntityIds.length || toCreateEdges.length || toDeleteEdgeIds.length);
      const metaMoved =
        meta.vocabVersion !== VOCAB_VERSION ||
        meta.gitCommit !== provenance.commit ||
        meta.gitBranch !== provenance.branch ||
        meta.gitDirty !== provenance.dirty;
      if (graphChanged || metaMoved) {
        await memory.updateRepository(REPOSITORY_ID, {
          metadata: { ...meta, vocabVersion: VOCAB_VERSION, gitCommit: provenance.commit, gitBranch: provenance.branch, gitDirty: provenance.dirty, builtAt },
        });
      }
    }
    console.log(`[code-graph] provenance: ${provenance.commit ?? '?'}${provenance.dirty ? '-dirty' : ''} (${provenance.branch ?? '?'}) built ${builtAt}`);

    // 9. Verify + a few sample queries demonstrating the graph's reach.
    const stats = await repo.getStats();
    console.log('[code-graph] stats:', JSON.stringify(stats, null, 2));

    // The zero-runtime-dependency invariant for core — should be 0 external runtime/peer edges.
    const coreRuntimeDeps = (await repo.executeNativeQuery(
      `MATCH (c:_Entity {repositoryId: $rid, entityType: 'Package', isCore: true})-[r:DEPENDS_ON_PACKAGE]->(t:_Entity {isWorkspace: false})
       WHERE r.properties CONTAINS '"depType":"dependency"' OR r.properties CONTAINS '"depType":"peerDependency"'
       RETURN t.label AS dep, r.properties AS props`,
      { rid: REPOSITORY_ID },
    )) as Array<{ dep: string; props: string }>;
    console.log(`[code-graph] core zero-runtime-dependency invariant: ${coreRuntimeDeps.length === 0 ? 'HOLDS (0 external runtime/peer deps)' : `VIOLATED — ${coreRuntimeDeps.map((d) => d.dep).join(', ')}`}`);

    // Provider conformance — contracts ranked by number of implementations.
    const contractImpls = (await repo.executeNativeQuery(
      `MATCH (c:_Entity {repositoryId: $rid, entityType: 'ProviderContract'})
       OPTIONAL MATCH (c)<-[:IMPLEMENTS]-(i:_Entity)
       RETURN c.label AS contract, count(i) AS impls ORDER BY impls DESC, contract`,
      { rid: REPOSITORY_ID },
    )) as Array<{ contract: string; impls: number }>;
    console.log('[code-graph] provider contracts and their implementations:');
    for (const row of contractImpls) console.log(`  ${row.impls}\t${row.contract}${row.impls === 0 ? '  (no implementation)' : ''}`);

    // Tools per server, with the read-only (non-mutating) split.
    const serverTools = (await repo.executeNativeQuery(
      `MATCH (s:_Entity {repositoryId: $rid, entityType: 'McpServer'})-[:ADVERTISES]->(t:_Entity)
       RETURN s.label AS server, count(t) AS tools,
         sum(CASE WHEN t.mutates THEN 0 ELSE 1 END) AS readOnly,
         sum(CASE WHEN t.mutates THEN 1 ELSE 0 END) AS mutating
       ORDER BY tools DESC`,
      { rid: REPOSITORY_ID },
    )) as Array<{ server: string; tools: number; readOnly: number; mutating: number }>;
    console.log('[code-graph] MCP tools per server (read-only / mutating):');
    for (const row of serverTools) console.log(`  ${row.tools}\t${row.server}  (${row.readOnly} read-only, ${row.mutating} mutating)`);

    // Workspace package fan-in — which package the most other workspace packages depend on.
    const fanIn = (await repo.executeNativeQuery(
      `MATCH (p:_Entity {repositoryId: $rid, entityType: 'Package', isWorkspace: true})<-[:DEPENDS_ON_PACKAGE]-(d:_Entity {isWorkspace: true})
       RETURN p.label AS pkg, count(DISTINCT d) AS dependents ORDER BY dependents DESC LIMIT 5`,
      { rid: REPOSITORY_ID },
    )) as Array<{ pkg: string; dependents: number }>;
    console.log('[code-graph] workspace packages by internal fan-in (most depended-on):');
    for (const row of fanIn) console.log(`  ${row.dependents}\t${row.pkg}`);

    // Doc/test coverage summary.
    const coverage = (await repo.executeNativeQuery(
      `MATCH (d:_Entity {repositoryId: $rid, entityType: 'Doc'})-[e:DOCUMENTS|MENTIONS]->(:_Entity)
       WITH count(DISTINCT d) AS docsWithRefs, count(e) AS docEdges
       MATCH (n:_Entity {repositoryId: $rid}) WHERE n.entityType IN ['ProviderContract','ProviderImpl'] AND NOT (n)<-[:COVERS]-(:_Entity)
       RETURN docsWithRefs, docEdges, count(n) AS uncoveredProviders`,
      { rid: REPOSITORY_ID },
    )) as Array<{ docsWithRefs: number; docEdges: number; uncoveredProviders: number }>;
    if (coverage[0]) console.log(`[code-graph] ${coverage[0].docsWithRefs} docs reference code via ${coverage[0].docEdges} edges; ${coverage[0].uncoveredProviders} provider nodes have no covering test`);

    // MCP tool test coverage — the testing-gap query the Test→McpTool COVERS edges enable.
    const toolCoverage = (await repo.executeNativeQuery(
      `MATCH (t:_Entity {repositoryId: $rid, entityType: 'McpTool'})
       OPTIONAL MATCH (t)<-[c:COVERS]-(:_Entity)
       WITH t, count(c) AS covers
       RETURN count(t) AS total, sum(CASE WHEN covers > 0 THEN 1 ELSE 0 END) AS covered`,
      { rid: REPOSITORY_ID },
    )) as Array<{ total: number; covered: number }>;
    if (toolCoverage[0]) console.log(`[code-graph] MCP tools with a covering test: ${toolCoverage[0].covered}/${toolCoverage[0].total}`);

    // Module import fan-in — the most depended-on source files (file-level blast radius).
    const moduleFanIn = (await repo.executeNativeQuery(
      `MATCH (m:_Entity {repositoryId: $rid, entityType: 'Module'})<-[:IMPORTS]-(d:_Entity {entityType: 'Module'})
       RETURN m.label AS module, count(DISTINCT d) AS importers ORDER BY importers DESC LIMIT 5`,
      { rid: REPOSITORY_ID },
    )) as Array<{ module: string; importers: number }>;
    console.log('[code-graph] source files by import fan-in (most depended-on — biggest blast radius):');
    for (const row of moduleFanIn) console.log(`  ${row.importers}\t${row.module}`);

    // Typed-error hierarchy — error types ranked by how many files throw them.
    const errorThrows = (await repo.executeNativeQuery(
      `MATCH (e:_Entity {repositoryId: $rid, entityType: 'ErrorType'})
       OPTIONAL MATCH (e)<-[:THROWS]-(m:_Entity)
       RETURN e.label AS error, count(DISTINCT m) AS thrownBy ORDER BY thrownBy DESC, error LIMIT 5`,
      { rid: REPOSITORY_ID },
    )) as Array<{ error: string; thrownBy: number }>;
    console.log('[code-graph] error types by throw-site count (most-thrown):');
    for (const row of errorThrows) console.log(`  ${row.thrownBy}\t${row.error}`);

    // Typed-errors convention — files throwing an error outside the modelled hierarchy.
    const rawErrors = (await repo.executeNativeQuery(
      `MATCH (m:_Entity {repositoryId: $rid, entityType: 'Module', throwsRawError: true})
       RETURN count(m) AS files`,
      { rid: REPOSITORY_ID },
    )) as Array<{ files: number }>;
    if (rawErrors[0]) console.log(`[code-graph] modules throwing a non-modelled error (typed-errors lead): ${rawErrors[0].files}`);
  } finally {
    await provider.dispose();
  }

  console.log('[code-graph] done.');
}

main().catch((error) => {
  console.error('[code-graph] failed:', error);
  process.exit(1);
});
