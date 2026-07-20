#!/usr/bin/env node
// Build the static graph-viewer data from the .dkg export bundles in exports/.
//
// For each exports/*.dkg (a ZIP archive) this:
//   1. Unzips it in memory with fflate (cross-platform; never shells out to `unzip`).
//   2. Reads manifest.json and concatenates every entities-*.json / relationships-*.json chunk.
//   3. STRIPS the `embedding` field (it is the bulk of the file size and the viewer never uses it).
//   4. Precomputes per-entity `degree` (count of relationships touching it).
//   5. Writes graph-viewer/data/<repositoryId>.json (one compact graph per export).
//   6. Writes graph-viewer/data/repositories.json (the dropdown index).
//
// Exports that carry the generic label "Indexed Repository" (or no label) get a
// distinguishable display label derived from the .dkg filename stem.
//
// Run: node scripts/build-graph-viewer.mjs   (or: pnpm build:graph-viewer)

import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const exportsDir = join(repoRoot, 'exports');
const dataDir = join(repoRoot, 'graph-viewer', 'data');

const GENERIC_LABELS = new Set(['', 'Indexed Repository']);

/** Parse a JSON file out of the unzipped archive map. */
function parseJson(files, name) {
  const buf = files[name];
  if (!buf) return undefined;
  return JSON.parse(strFromU8(buf));
}

/** Collect, sort, and concatenate every chunk file matching a prefix (entities-0001.json, …). */
function concatChunks(files, prefix) {
  const names = Object.keys(files)
    .filter((n) => new RegExp(`^${prefix}-\\d+\\.json$`).test(n))
    .sort();
  const out = [];
  for (const name of names) {
    const arr = parseJson(files, name);
    if (Array.isArray(arr)) out.push(...arr);
  }
  return out;
}

/** Turn a .dkg filename into a readable fallback label: drops the extension and trailing version/datetime noise. */
function stemLabel(file) {
  const stem = basename(file).replace(/\.(dkg|zip)$/i, '');
  // Filename pattern is {slugified-label}-v{version}-{datetime}; trim a trailing -vX... if present.
  const trimmed = stem.replace(/-v\d[\w.-]*$/i, '');
  return trimmed || stem;
}

function processArchive(file) {
  const bytes = new Uint8Array(readFileSync(join(exportsDir, file)));
  const files = unzipSync(bytes);

  const manifest = parseJson(files, 'manifest.json');
  if (!manifest || !manifest.repository) {
    throw new Error(`manifest.json missing or malformed in ${file}`);
  }

  const rawEntities = concatChunks(files, 'entities');
  const rawRelationships = concatChunks(files, 'relationships');

  // Precompute degree: count every relationship touching an entity (source or target).
  const degree = new Map();
  for (const r of rawRelationships) {
    degree.set(r.sourceEntityId, (degree.get(r.sourceEntityId) ?? 0) + 1);
    degree.set(r.targetEntityId, (degree.get(r.targetEntityId) ?? 0) + 1);
  }

  // Strip embedding; keep provenance (tiny, powers the detail panel).
  const entities = rawEntities.map((e) => ({
    id: e.id,
    slug: e.slug,
    entityType: e.entityType,
    label: e.label,
    summary: e.summary,
    properties: e.properties ?? {},
    provenance: e.provenance,
    degree: degree.get(e.id) ?? 0,
  }));

  // Rename to the viewer's compact field names.
  const relationships = rawRelationships.map((r) => ({
    id: r.id,
    type: r.relationshipType,
    source: r.sourceEntityId,
    target: r.targetEntityId,
    properties: r.properties ?? {},
    bidirectional: !!r.bidirectional,
  }));

  const stats = manifest.statistics ?? {};
  const rawLabel = (manifest.repository.label ?? '').trim();
  const displayLabel = GENERIC_LABELS.has(rawLabel) ? stemLabel(file) : rawLabel;

  return {
    repositoryId: manifest.repository.repositoryId,
    rawLabel,
    displayLabel,
    sourceFile: file,
    perRepo: {
      manifest: {
        repositoryId: manifest.repository.repositoryId,
        label: displayLabel,
        rawLabel,
        sourceFile: file,
        vocabularyVersion: manifest.repository.vocabularyVersion,
        governanceMode: manifest.repository.governanceMode,
        exportedAt: manifest.exportedAt,
        libraryVersion: manifest.libraryVersion,
        embedding: manifest.embedding,
        statistics: {
          entityCount: stats.entityCount ?? entities.length,
          relationshipCount: stats.relationshipCount ?? relationships.length,
          entityTypeBreakdown: stats.entityTypeBreakdown ?? {},
          relationshipTypeBreakdown: stats.relationshipTypeBreakdown ?? {},
        },
      },
      entities,
      relationships,
    },
  };
}

function main() {
  if (!existsSync(exportsDir)) {
    console.error(`No exports/ directory found at ${exportsDir}`);
    process.exit(1);
  }

  const dkgFiles = readdirSync(exportsDir)
    .filter((f) => /\.(dkg|zip)$/i.test(f))
    .sort();

  if (dkgFiles.length === 0) {
    console.error(`No .dkg/.zip archives found in ${exportsDir}`);
    process.exit(1);
  }

  // Fresh data dir each run so removed exports don't leave stale files behind.
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });

  const index = [];
  const usedFileNames = new Set();
  const labelCounts = new Map();

  const processed = [];
  for (const file of dkgFiles) {
    try {
      processed.push(processArchive(file));
    } catch (err) {
      console.error(`  ✗ ${file}: ${err.message}`);
    }
  }

  // Disambiguate labels shared by multiple exports (e.g. two "Indexed Repository" snapshots).
  for (const p of processed) {
    labelCounts.set(p.displayLabel, (labelCounts.get(p.displayLabel) ?? 0) + 1);
  }

  for (const p of processed) {
    let label = p.displayLabel;
    if (labelCounts.get(label) > 1) {
      label = `${label} (${stemLabel(p.sourceFile)})`;
    }
    p.perRepo.manifest.label = label;

    // Output filename keyed by repositoryId; disambiguate if two exports share an id.
    let fileName = `${p.repositoryId}.json`;
    let n = 2;
    while (usedFileNames.has(fileName)) {
      fileName = `${p.repositoryId}-${n++}.json`;
    }
    usedFileNames.add(fileName);

    writeFileSync(join(dataDir, fileName), JSON.stringify(p.perRepo));

    const stats = p.perRepo.manifest.statistics;
    index.push({
      repositoryId: p.repositoryId,
      label,
      file: fileName,
      sourceFile: p.sourceFile,
      entityCount: stats.entityCount,
      relationshipCount: stats.relationshipCount,
      entityTypeBreakdown: stats.entityTypeBreakdown,
    });

    console.log(
      `  ✓ ${p.sourceFile} → data/${fileName}  (${stats.entityCount} entities, ${stats.relationshipCount} relationships) "${label}"`,
    );
  }

  index.sort((a, b) => a.label.localeCompare(b.label));
  writeFileSync(join(dataDir, 'repositories.json'), JSON.stringify(index, null, 2));

  console.log(`\nWrote ${index.length} repositor${index.length === 1 ? 'y' : 'ies'} to graph-viewer/data/`);
}

main();
