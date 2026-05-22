#!/usr/bin/env node

/**
 * Publish script for @utaba/deep-memory packages.
 *
 * Publishes public packages to npm in dependency order:
 *   1. @utaba/deep-memory (core)
 *   2. @utaba/deep-memory-embeddings-openai
 *   3. @utaba/deep-memory-storage-cosmosdb
 *   4. @utaba/deep-memory-storage-sqlserver
 *   5. @utaba/deep-memory-local-mcp-server
 *
 * Indexer packages (indexer, indexer-llm-anthropic, indexer-mcp-server)
 * are intentionally excluded — they are marked "private": true and are
 * intended to be run from a clone of this repo, not installed via npm.
 *
 * Usage:
 *   pnpm release           # build, test, and publish all packages
 *   pnpm release --dry-run # build, test, and preview what would be published
 *
 * Prerequisites:
 *   - Logged in to npm with publish rights on the @utaba scope (npm whoami)
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const dryRun = process.argv.includes('--dry-run');

// Packages in publish order (core first, then dependants)
const packages = [
  { name: '@utaba/deep-memory', path: 'packages/core' },
  { name: '@utaba/deep-memory-embeddings-openai', path: 'packages/embeddings-openai' },
  { name: '@utaba/deep-memory-storage-cosmosdb', path: 'packages/storage-cosmosdb' },
  { name: '@utaba/deep-memory-storage-sqlserver', path: 'packages/storage-sqlserver' },
  { name: '@utaba/deep-memory-local-mcp-server', path: 'packages/mcp-server' },
];

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', cwd: rootDir, ...opts });
}

function getLocalVersion(pkgPath) {
  const json = JSON.parse(readFileSync(resolve(rootDir, pkgPath, 'package.json'), 'utf8'));
  return json.version;
}

function getPublishedVersion(name) {
  try {
    const result = execSync(`npm view ${name} version 2>/dev/null`, { encoding: 'utf8' }).trim();
    return result || null;
  } catch {
    return null;
  }
}

function listPackageFiles(pkgPath) {
  try {
    const result = execSync('pnpm pack --dry-run 2>&1', { encoding: 'utf8', cwd: resolve(rootDir, pkgPath) });
    return result;
  } catch {
    return '  (could not list files)';
  }
}

// ── Preflight checks ────────────────────────────────────────────────

console.log('\n🔍 Preflight checks\n');

// Verify npm login (skip in dry-run — you might want to preview without being logged in)
if (!dryRun) {
  try {
    const user = execSync('npm whoami', { encoding: 'utf8' }).trim();
    console.log(`  ✔ Logged in as: ${user}`);
  } catch {
    console.error('  ✖ Not logged in to npm. Run: npm login');
    process.exit(1);
  }
}

// Build and test
console.log('\n📦 Building all packages\n');
run('pnpm build');

console.log('\n🧪 Running tests\n');
run('pnpm test');

console.log('\n✅ Typechecking\n');
run('pnpm typecheck');

// ── Publish ─────────────────────────────────────────────────────────

console.log(dryRun ? '\n📋 Dry run — previewing packages\n' : '\n🚀 Publishing packages\n');

let published = 0;
let skipped = 0;

for (const pkg of packages) {
  const localVersion = getLocalVersion(pkg.path);
  const publishedVersion = getPublishedVersion(pkg.name);

  console.log(`\n  ${pkg.name}@${localVersion}`);

  if (publishedVersion === localVersion) {
    console.log(`  ⏭  Already published at ${localVersion}, skipping`);
    skipped++;
    continue;
  }

  if (publishedVersion) {
    console.log(`  ↑  Would update ${publishedVersion} → ${localVersion}`);
  } else {
    console.log(`  ✨ First publish`);
  }

  if (dryRun) {
    console.log(`  📦 Files that would be published:`);
    console.log(listPackageFiles(pkg.path));
    published++;
  } else {
    run(`pnpm publish --no-git-checks`, { cwd: resolve(rootDir, pkg.path) });
    published++;
  }
}

// ── Summary ─────────────────────────────────────────────────────────

console.log('\n────────────────────────────────────────');
if (dryRun) {
  console.log(`  🏁 Dry run complete — ${published} would be published, ${skipped} already up to date`);
} else {
  console.log(`  🏁 Done — ${published} published, ${skipped} skipped`);
}
console.log('────────────────────────────────────────\n');
