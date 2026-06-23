/**
 * Deterministic extractor for the package dependency graph.
 *
 * Reads every workspace package.json under packages/* and surfaces, for each, its npm name,
 * directory, and declared dependencies. Pure fs/JSON — no ts-morph, no module execution.
 *
 * Edge policy (applied in rebuild.ts): workspace-internal deps are captured for all three
 * fields (dependency/peerDependency/devDependency); edges to external packages are created
 * only for dependency + peerDependency (runtime + peer), so external build-tooling devDeps
 * (turbo, vitest, typescript, @types/*) don't flood the graph. `core` should emit no external
 * runtime/peer edge — the zero-runtime-dependency invariant, made queryable.
 */
import fs from 'fs';
import path from 'path';

export type DepType = 'dependency' | 'peerDependency' | 'devDependency';

export interface PackageDep {
  /** The depended-on npm package name. */
  name: string;
  depType: DepType;
}

export interface PackageInfo {
  /** npm package name (the node label). */
  name: string;
  /** Workspace directory relative to the repo root, e.g. packages/core. */
  dir: string;
  deps: PackageDep[];
}

function readDeps(json: Record<string, unknown>, field: string, depType: DepType): PackageDep[] {
  const block = json[field];
  if (!block || typeof block !== 'object') return [];
  return Object.keys(block as Record<string, string>).map((name) => ({ name, depType }));
}

export function extractPackages(repoRoot: string): PackageInfo[] {
  const packagesDir = path.join(repoRoot, 'packages');
  const entries = fs.readdirSync(packagesDir, { withFileTypes: true });

  const packages: PackageInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = path.join(packagesDir, entry.name, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;

    const json = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>;
    const name = typeof json.name === 'string' ? json.name : entry.name;

    packages.push({
      name,
      dir: path.relative(repoRoot, path.join(packagesDir, entry.name)),
      deps: [
        ...readDeps(json, 'dependencies', 'dependency'),
        ...readDeps(json, 'peerDependencies', 'peerDependency'),
        ...readDeps(json, 'devDependencies', 'devDependency'),
      ],
    });
  }

  return packages;
}
