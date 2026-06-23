/**
 * Deterministic extractor for the tests layer.
 *
 * Walks the co-located test files under packages/*‍/src/** and surfaces, per test:
 *   - the local symbol names it imports — resolved against modelled ProviderImpl / ProviderContract
 *     entities and MCP tool classes in rebuild.ts (imports-primary): a COVERS edge is created for
 *     every imported symbol that resolves to a modelled node.
 *   - its intra-repo relative imports, resolved to the exact target source file (mirroring the
 *     resolver in extract-modules.ts: ESM `.js` specifiers mapped back to `.ts`, bare directories to
 *     `index.ts`). These become Test ─COVERS→ Module edges in rebuild.ts, so "which of the source
 *     files has no test importing it" becomes queryable across the whole repo — not just the
 *     providers/tools the symbol-based COVERS edges reach.
 *
 * Non-modelled imports (vitest, types) are dropped, exactly as DOCUMENTS drops non-modelled links.
 * Pure static AST analysis via ts-morph — no module execution, no LLM.
 */
import path from 'path';
import { Project } from 'ts-morph';

export interface TestInfo {
  /** Test file path relative to the repo root — the node label and natural key (filenames collide). */
  filePath: string;
  /** Distinct local symbol names imported by the file (named + default imports). */
  importedSymbols: string[];
  /** Repo-relative paths of intra-repo source modules this test imports (relative specifiers, resolved). */
  importsModules: string[];
}

const TEST_FILE = /\.(test|spec)\.ts$/;

/** Resolve a relative ESM specifier to a known source file (`.js`→`.ts`, dir→`index.ts`). */
function resolveRelative(fromAbs: string, specifier: string, moduleAbsSet: Set<string>): string | null {
  const base = specifier.replace(/\.[cm]?[jt]s$/, '');
  const resolvedBase = path.resolve(path.dirname(fromAbs), base);
  for (const candidate of [`${resolvedBase}.ts`, path.join(resolvedBase, 'index.ts')]) {
    if (moduleAbsSet.has(candidate)) return candidate;
  }
  return null;
}

export function extractTests(repoRoot: string): TestInfo[] {
  const project = new Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true });
  project.addSourceFilesAtPaths(path.join(repoRoot, 'packages/*/src/**/*.ts'));

  const allFiles = project.getSourceFiles();
  // The Module universe (non-test source files) — the resolution target set, mirroring extract-modules.ts.
  const moduleAbsSet = new Set(
    allFiles
      .filter((sf) => !TEST_FILE.test(sf.getFilePath()) && !sf.getFilePath().includes('__tests__'))
      .map((sf) => sf.getFilePath()),
  );

  const tests: TestInfo[] = [];
  for (const sourceFile of allFiles) {
    const abs = sourceFile.getFilePath();
    if (!TEST_FILE.test(abs)) continue;

    // The exported symbol names from every import declaration. Namespace imports (`import * as X`)
    // are skipped: the binding is the module, not a symbol resolving to a node.
    const importedSymbols = new Set<string>();
    const importsModules = new Set<string>();
    for (const imp of sourceFile.getImportDeclarations()) {
      for (const named of imp.getNamedImports()) importedSymbols.add(named.getName());
      const def = imp.getDefaultImport()?.getText();
      if (def) importedSymbols.add(def);
      // Relative specifier → the exact source file it imports (the Test → Module coverage signal).
      const spec = imp.getModuleSpecifierValue();
      if (spec.startsWith('.')) {
        const target = resolveRelative(abs, spec, moduleAbsSet);
        if (target) importsModules.add(path.relative(repoRoot, target));
      }
    }

    tests.push({
      filePath: path.relative(repoRoot, abs),
      importedSymbols: [...importedSymbols],
      importsModules: [...importsModules],
    });
  }
  return tests;
}
