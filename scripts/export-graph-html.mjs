#!/usr/bin/env node
// Export self-contained, single-file HTML graph viewers.
//
// For people with NO database (and non-technical viewers): this bakes a repository's graph data
// straight into a copy of the viewer page, producing one .html file per repository that you can
// hand to anyone. They just double-click it — no server, no database, no terminal. (Cytoscape.js
// still loads from a CDN, so the file needs internet to render; everything else is inlined.)
//
// It pulls data live from the same provider the MCP server / live viewer use (.mcp.json env block,
// overridable by DEEP_MEMORY_* in the environment), so you generate the files, then share them.
//
// Run: node scripts/export-graph-html.mjs [--repo <id>|all] [--out <dir>] [--mcp .mcp.json] [--server-key deep-memory]
//      (or: pnpm export:graph-html).  Requires `pnpm build` first — it imports the built packages.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig, buildDeepMemory, listRepositoriesWithStats, buildGraphPayload } from './lib/graph-data.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const templatePath = join(repoRoot, 'graph-viewer', 'index.html');
const EMBED_MARKER = '<!-- __DEEP_MEMORY_EMBED__ -->';

function parseArgs(argv) {
  const out = {
    repo: 'all',
    outDir: join(repoRoot, 'graph-viewer', 'dist'),
    mcp: join(repoRoot, '.mcp.json'),
    serverKey: 'deep-memory',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--out') out.outDir = resolve(argv[++i]);
    else if (a === '--mcp') out.mcp = argv[++i];
    else if (a === '--server-key') out.serverKey = argv[++i];
  }
  return out;
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'graph';
}

/** Serialise a JS value for safe inlining inside an HTML <script> block. */
function toInlineJson(value) {
  // Neutralise </script> and <!-- (stays valid once parsed back as JS), and escape the U+2028 /
  // U+2029 separators that are illegal in older JS string literals. The separator regex is built
  // from an ASCII string so no literal separator characters appear in this source file.
  const SEPARATORS = new RegExp('[\\u2028\\u2029]', 'g');
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(SEPARATORS, (c) => '\\u' + c.charCodeAt(0).toString(16));
}

function renderFile(template, embed) {
  if (!template.includes(EMBED_MARKER)) {
    throw new Error(`Template ${templatePath} is missing the ${EMBED_MARKER} marker.`);
  }
  const script = `<script>window.__DEEP_MEMORY_EMBED__ = ${toInlineJson(embed)};</script>`;
  return template.replace(EMBED_MARKER, script);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = resolveConfig(args.mcp, args.serverKey);
  const { deepMemory, storageSetting } = buildDeepMemory(cfg);
  const template = readFileSync(templatePath, 'utf8');

  try {
    const all = await listRepositoriesWithStats(deepMemory);
    const selected = args.repo === 'all' ? all : all.filter((r) => r.repositoryId === args.repo);

    if (selected.length === 0) {
      console.error(
        args.repo === 'all'
          ? `No repositories found in the configured storage (${storageSetting}).`
          : `Repository "${args.repo}" not found. Available: ${all.map((r) => r.repositoryId).join(', ') || '(none)'}`,
      );
      process.exit(1);
    }

    mkdirSync(args.outDir, { recursive: true });
    const usedNames = new Set();

    for (const summary of selected) {
      const payload = await buildGraphPayload(deepMemory, summary.repositoryId);
      const embed = {
        repos: [{
          repositoryId: summary.repositoryId,
          label: payload.manifest.label ?? summary.label,
          entityCount: payload.manifest.statistics.entityCount,
          relationshipCount: payload.manifest.statistics.relationshipCount,
        }],
        graphs: { [summary.repositoryId]: payload },
      };

      const base = slugify(payload.manifest.label ?? summary.label);
      let fileName = `${base}.html`;
      let n = 2;
      while (usedNames.has(fileName)) fileName = `${base}-${n++}.html`;
      usedNames.add(fileName);

      const outPath = join(args.outDir, fileName);
      writeFileSync(outPath, renderFile(template, embed));
      console.log(
        `  ✓ ${fileName}  (${embed.repos[0].entityCount} entities, ${embed.repos[0].relationshipCount} relationships) "${embed.repos[0].label}"`,
      );
    }

    console.log(`\nWrote ${selected.length} file${selected.length === 1 ? '' : 's'} to ${args.outDir}`);
    console.log('Open one in a browser (double-click) or share it — no server or database needed.');
  } finally {
    try { await deepMemory.dispose(); } catch { /* best effort */ }
  }
}

main().catch((err) => {
  console.error('Export failed:', err);
  process.exit(1);
});
