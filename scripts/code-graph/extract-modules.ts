/**
 * Deterministic extractor for the file-level module dependency layer.
 *
 * Walks every non-test source file under packages/*‍/src and surfaces, per file:
 *   - its intra-repo imports — relative specifiers resolved to the exact target source file
 *     (ESM `.js` specifiers are mapped back to their `.ts` source; bare directories resolve to
 *     `index.ts`). These become Module ─IMPORTS→ Module edges in rebuild.ts.
 *   - its bare-package imports — the npm package names it imports (workspace or external). These
 *     become Module ─IMPORTS→ Package edges, giving file-level cross-package reach (e.g. "which
 *     files import neo4j-driver / @utaba/deep-memory") that the package-level DEPENDS_ON_PACKAGE
 *     graph can't express.
 *   - the error constructors it throws (`throw new XError(...)`) — resolved against modelled
 *     ErrorTypes (THROWS edges) in rebuild.ts; an unresolved one (the JS builtin `Error`, a
 *     private error) is what flags the typed-error-convention escape hatch.
 *
 * Pure static AST via ts-morph — no module execution, no LLM. Package attribution and edge
 * resolution against modelled nodes happen in rebuild.ts (it owns the package id/name maps).
 */
import path from 'path';
import { Project, SyntaxKind } from 'ts-morph';

export interface ModuleInfo {
  /** Repo-relative source file path — the node label and natural key. */
  filePath: string;
  /** True for a barrel (index.ts), which mostly re-exports rather than defines. */
  isBarrel: boolean;
  /** Repo-relative paths of intra-repo source files this file imports/re-exports from. */
  importsModules: string[];
  /** Bare npm package names (workspace or external) this file imports/re-exports from. */
  importsPackages: string[];
  /** Simple class names thrown via `throw new X(...)` whose name ends in "Error". */
  throwsErrorCtors: string[];
}

const TEST_FILE = /\.(test|spec)\.ts$/;
const ERROR_CTOR = /Error$/;

/** Resolve a relative ESM specifier to a known source file (`.js`→`.ts`, dir→`index.ts`). */
function resolveRelative(fromAbs: string, specifier: string, moduleAbsSet: Set<string>): string | null {
  const base = specifier.replace(/\.[cm]?[jt]s$/, '');
  const resolvedBase = path.resolve(path.dirname(fromAbs), base);
  for (const candidate of [`${resolvedBase}.ts`, path.join(resolvedBase, 'index.ts')]) {
    if (moduleAbsSet.has(candidate)) return candidate;
  }
  return null;
}

/** The npm package name a bare specifier refers to (handles @scope/name and subpaths). */
function bareName(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('node:')) return null;
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] ?? null;
}

export function extractModules(repoRoot: string): ModuleInfo[] {
  const project = new Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true });
  project.addSourceFilesAtPaths(path.join(repoRoot, 'packages/*/src/**/*.ts'));

  const sourceFiles = project
    .getSourceFiles()
    .filter((sf) => !TEST_FILE.test(sf.getFilePath()) && !sf.getFilePath().includes('__tests__'));
  const moduleAbsSet = new Set(sourceFiles.map((sf) => sf.getFilePath()));

  const modules: ModuleInfo[] = [];
  for (const sf of sourceFiles) {
    const abs = sf.getFilePath();

    // Both `import ... from 'x'` and `export ... from 'x'` (barrel re-exports) are dependencies.
    const specifiers = new Set<string>();
    for (const imp of sf.getImportDeclarations()) specifiers.add(imp.getModuleSpecifierValue());
    for (const exp of sf.getExportDeclarations()) {
      const spec = exp.getModuleSpecifierValue();
      if (spec) specifiers.add(spec);
    }

    const importsModules = new Set<string>();
    const importsPackages = new Set<string>();
    for (const spec of specifiers) {
      if (spec.startsWith('.')) {
        const target = resolveRelative(abs, spec, moduleAbsSet);
        if (target) importsModules.add(path.relative(repoRoot, target));
      } else {
        const name = bareName(spec);
        if (name) importsPackages.add(name);
      }
    }

    const throwsErrorCtors = new Set<string>();
    for (const thr of sf.getDescendantsOfKind(SyntaxKind.ThrowStatement)) {
      const ne = thr.getExpression()?.asKind(SyntaxKind.NewExpression);
      if (!ne) continue;
      const simple = ne.getExpression().getText().split('<')[0]!.trim().split('.').pop() ?? '';
      if (ERROR_CTOR.test(simple)) throwsErrorCtors.add(simple);
    }

    modules.push({
      filePath: path.relative(repoRoot, abs),
      isBarrel: path.basename(abs) === 'index.ts',
      importsModules: [...importsModules],
      importsPackages: [...importsPackages],
      throwsErrorCtors: [...throwsErrorCtors],
    });
  }

  return modules;
}
