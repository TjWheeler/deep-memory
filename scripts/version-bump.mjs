#!/usr/bin/env node

/**
 * DEPRECATED — superseded by Changesets (2026-05-22).
 *
 * Version bumps are now driven by `pnpm changeset` (author intent) +
 * `pnpm changeset version` (apply pending changesets). See CONTRIBUTING.md
 * and `.changeset/config.json`.
 *
 * The five published packages are in a `fixed` group, so they always bump
 * together — same effective behaviour as this script gave the published set.
 *
 * This file is kept only as a fallback for emergency synchronized bumps; do
 * not use it in normal development.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, statSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const packagesDir = resolve(rootDir, 'packages');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bumpType = args.find((a) => ['patch', 'minor', 'major'].includes(a)) ?? 'minor';

function bumpVersion(version, type) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(-.+)?$/);
  if (!match) throw new Error(`Unrecognised version format: ${version}`);
  const [, major, minor, patch, pre] = match;
  const suffix = pre ?? '';
  switch (type) {
    case 'major':
      return `${Number(major) + 1}.0.0${suffix}`;
    case 'minor':
      return `${major}.${Number(minor) + 1}.0${suffix}`;
    case 'patch':
      return `${major}.${minor}.${Number(patch) + 1}${suffix}`;
    default:
      throw new Error(`Unknown bump type: ${type}`);
  }
}

const packageDirs = readdirSync(packagesDir).filter((name) => {
  try {
    return statSync(resolve(packagesDir, name)).isDirectory();
  } catch {
    return false;
  }
});

console.log(
  dryRun
    ? `\n📋 Dry run — previewing ${bumpType} version bumps\n`
    : `\nBumping ${bumpType} versions\n`
);

for (const dir of packageDirs) {
  const pkgPath = resolve(packagesDir, dir, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    continue;
  }

  const oldVersion = pkg.version;
  if (!oldVersion) continue;

  const newVersion = bumpVersion(oldVersion, bumpType);
  console.log(`  ${pkg.name}: ${oldVersion} -> ${newVersion}`);

  if (!dryRun) {
    pkg.version = newVersion;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  }
}

console.log(dryRun ? '\nDry run complete — no files written\n' : '\nDone\n');
