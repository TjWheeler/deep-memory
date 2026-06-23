/**
 * Deterministic extractor for the tests layer.
 *
 * Walks the co-located test files under packages/*‍/src/** and surfaces, per test, the local
 * symbol names it imports. Resolution against modelled ProviderImpl / ProviderContract entities
 * happens in rebuild.ts (imports-primary): a COVERS edge is created for every imported symbol
 * that resolves to a modelled node (an impl class by name, or a contract interface by name).
 * Non-modelled imports (vitest, helpers, types) are dropped, exactly as DOCUMENTS drops
 * non-modelled links. Pure static AST analysis via ts-morph — no module execution, no LLM.
 */
import path from 'path';
import { Project } from 'ts-morph';

export interface TestInfo {
  /** Test file path relative to the repo root — the node label and natural key (filenames collide). */
  filePath: string;
  /** Distinct local symbol names imported by the file (named + default imports). */
  importedSymbols: string[];
}

const TEST_FILE = /\.(test|spec)\.ts$/;

export function extractTests(repoRoot: string): TestInfo[] {
  const project = new Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true });
  project.addSourceFilesAtPaths(path.join(repoRoot, 'packages/*/src/**/*.test.ts'));
  project.addSourceFilesAtPaths(path.join(repoRoot, 'packages/*/src/**/*.spec.ts'));

  const tests: TestInfo[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();
    if (!TEST_FILE.test(filePath)) continue;

    // The exported symbol names from every import declaration. Namespace imports (`import * as X`)
    // are skipped: the binding is the module, not a symbol resolving to a node.
    const importedSymbols = new Set<string>();
    for (const imp of sourceFile.getImportDeclarations()) {
      for (const named of imp.getNamedImports()) importedSymbols.add(named.getName());
      const def = imp.getDefaultImport()?.getText();
      if (def) importedSymbols.add(def);
    }

    tests.push({ filePath: path.relative(repoRoot, filePath), importedSymbols: [...importedSymbols] });
  }
  return tests;
}
