/**
 * Deterministic extractor for the typed-error hierarchy.
 *
 * Scans packages/*‍/src via ts-morph for every EXPORTED class whose `extends` base name ends in
 * "Error" — the typed-error tree the codebase mandates callers throw and catch (CLAUDE.md:
 * "Typed errors only. Throw from the hierarchy in packages/core/src/core/errors.ts"). Captures the
 * class name, its file, and the base it extends, so rebuild.ts can build:
 *   - ErrorType nodes (the exported error classes), and
 *   - ErrorType ─EXTENDS→ ErrorType edges (subclass → superclass) — the catchability chain
 *     (catching DeepMemoryError catches every subclass).
 *
 * `extendsBuiltin` marks a root that extends the JS builtin `Error` directly (e.g. DeepMemoryError);
 * the builtin is intentionally not modelled as a node. Module-private (non-exported) errors are
 * excluded, matching the graph's "exported construct" convention — a file throwing one shows up via
 * the Module.throwsRawError flag instead. THROWS edges are resolved from Module data in rebuild.ts.
 */
import path from 'path';
import { Project } from 'ts-morph';

export interface ErrorTypeInfo {
  /** Class name — the node label, e.g. RepositoryNotFoundError. */
  className: string;
  /** Source file path relative to the repo root. */
  filePath: string;
  /** Name of the class it extends (e.g. DeepMemoryError, ImportError, or Error). */
  extendsName: string;
  /** True when it extends the JS builtin `Error` directly — a hierarchy root. */
  extendsBuiltin: boolean;
}

const TEST_FILE = /\.(test|spec)\.ts$/;
const ERROR_NAME = /Error$/;

export function extractErrors(repoRoot: string): ErrorTypeInfo[] {
  const project = new Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true });
  project.addSourceFilesAtPaths(path.join(repoRoot, 'packages/*/src/**/*.ts'));

  const errors: ErrorTypeInfo[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();
    if (TEST_FILE.test(filePath) || filePath.includes('__tests__')) continue;
    const rel = path.relative(repoRoot, filePath);

    for (const cls of sourceFile.getClasses()) {
      const className = cls.getName();
      if (!className || !cls.isExported()) continue;
      const base = cls.getExtends()?.getExpression().getText().split('<')[0]?.trim();
      if (!base || !ERROR_NAME.test(base)) continue;
      errors.push({ className, filePath: rel, extendsName: base, extendsBuiltin: base === 'Error' });
    }
  }

  return errors;
}
