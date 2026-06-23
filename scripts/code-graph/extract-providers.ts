/**
 * Deterministic extractor for the pluggable-provider seam.
 *
 * Scans packages/*‍/src via ts-morph (no module execution, no LLM) for:
 *   - ProviderContracts — every `export interface *Provider` declaration. The naming convention
 *     (interface name ends in "Provider") is the discriminator: it captures StorageProvider,
 *     SearchProvider, EmbeddingProvider, GraphTraversalProvider, LockProvider (core) and
 *     LLMProvider (indexer), while excluding helper interfaces (SearchableEntity, LockOptions…).
 *   - ProviderImpls — a class that satisfies a contract either:
 *       • nominally   — it has an `implements <X>` clause where X ends in "Provider"
 *                       (CosmosDbProvider implements StorageProvider + GraphTraversalProvider); or
 *       • structurally — its own method surface declares every REQUIRED member of the contract,
 *                       even with no `implements` clause. This is what makes Neo4jStorageProvider
 *                       visible: it deliberately defers its `implements StorageProvider` declaration
 *                       (see that file's header) yet declares the full surface, so a nominal-only
 *                       scan would silently drop the storage/traversal backend that powers the
 *                       code-graph itself. Structural matching is restricted to *Provider-named
 *                       classes (the same convention the extractor already trusts) and to contracts
 *                       with ≥ 2 required methods, so a tiny interface can't be matched by accident.
 *     Each contract a class implements is recorded with how it was discovered (nominal | structural);
 *     nominal wins if a contract is found both ways.
 *
 * IMPLEMENTS / CONTAINS edge resolution against the modelled nodes happens in rebuild.ts.
 */
import path from 'path';
import { Project, SyntaxKind } from 'ts-morph';

export type ContractDetection = 'nominal' | 'structural';

export interface ImplementedContract {
  /** Provider contract (interface) name — the IMPLEMENTS target label, e.g. StorageProvider. */
  name: string;
  /** How the implements relationship was discovered. */
  detection: ContractDetection;
}

export interface ProviderContractInfo {
  /** Interface name — the node label, e.g. StorageProvider. */
  name: string;
  /** Source file path relative to the repo root. */
  filePath: string;
}

export interface ProviderImplInfo {
  /** Class name — the node label, e.g. SqlServerStorageProvider. */
  className: string;
  /** Source file path relative to the repo root. */
  filePath: string;
  /** The *Provider contracts this class implements (one IMPLEMENTS edge each), with detection. */
  contracts: ImplementedContract[];
}

const PROVIDER_NAME = /Provider$/;

// A contract must declare at least this many required methods before structural matching is
// considered — guards against trivially matching a tiny interface by coincidence.
const MIN_STRUCTURAL_METHODS = 2;

export interface ProvidersResult {
  contracts: ProviderContractInfo[];
  impls: ProviderImplInfo[];
}

interface CandidateClass {
  className: string;
  filePath: string;
  /** The class's own declared method names. */
  methodNames: Set<string>;
  /** *Provider contracts named in the class's `implements` clause. */
  nominalContracts: string[];
}

export function extractProviders(repoRoot: string): ProvidersResult {
  const project = new Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true });
  project.addSourceFilesAtPaths(path.join(repoRoot, 'packages/*/src/**/*.ts'));

  const contracts: ProviderContractInfo[] = [];
  // contract name -> set of its REQUIRED (non-optional) method names: the structural-conformance key.
  const requiredMethodsByContract = new Map<string, Set<string>>();
  const candidates: CandidateClass[] = [];

  // Pass 1 — collect every contract (with its required surface) and every candidate class.
  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();
    if (/\.(test|spec)\.ts$/.test(filePath) || filePath.includes('__tests__')) continue;
    const rel = path.relative(repoRoot, filePath);

    for (const iface of sourceFile.getInterfaces()) {
      const name = iface.getName();
      if (!iface.isExported() || !PROVIDER_NAME.test(name)) continue;
      contracts.push({ name, filePath: rel });
      const required = new Set<string>();
      for (const method of iface.getMethods()) {
        if (!method.hasQuestionToken()) required.add(method.getName());
      }
      requiredMethodsByContract.set(name, required);
    }

    for (const cls of sourceFile.getClasses()) {
      const className = cls.getName();
      if (!className) continue;
      // The text of each `implements` expression, with any generic type arguments stripped.
      const nominalContracts = cls
        .getImplements()
        .map((expr) => expr.getExpressionIfKind(SyntaxKind.Identifier)?.getText() ?? expr.getExpression().getText())
        .map((text) => text.split('<')[0]!.trim())
        .filter((text) => PROVIDER_NAME.test(text));
      const methodNames = new Set(cls.getMethods().map((method) => method.getName()));
      candidates.push({ className, filePath: rel, methodNames, nominalContracts });
    }
  }

  // Pass 2 — resolve each candidate's contracts: nominal clauses, then structural conformance.
  const impls: ProviderImplInfo[] = [];
  for (const cand of candidates) {
    const detectionByContract = new Map<string, ContractDetection>();
    for (const name of cand.nominalContracts) detectionByContract.set(name, 'nominal');

    // Structural: a *Provider-named class that declares every required member of a contract it
    // does not already implement nominally. Restricting to *Provider names keeps internal helpers
    // (e.g. *TraversalExecutor delegates) out of the seam — only the registered provider matches.
    if (PROVIDER_NAME.test(cand.className)) {
      for (const [contractName, required] of requiredMethodsByContract) {
        if (detectionByContract.has(contractName)) continue; // nominal wins
        if (required.size < MIN_STRUCTURAL_METHODS) continue;
        const satisfiesAll = [...required].every((member) => cand.methodNames.has(member));
        if (satisfiesAll) detectionByContract.set(contractName, 'structural');
      }
    }

    if (detectionByContract.size === 0) continue;
    impls.push({
      className: cand.className,
      filePath: cand.filePath,
      contracts: [...detectionByContract].map(([name, detection]) => ({ name, detection })),
    });
  }

  return { contracts, impls };
}
