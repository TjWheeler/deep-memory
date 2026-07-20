#!/usr/bin/env node
// Live data server for the static graph-viewer.
//
// The viewer is a static HTML page; a browser can't open a database connection (and shouldn't
// hold credentials). This small Node server bridges the gap: it reuses the SAME provider config
// the MCP server uses, connects to whatever storage backend is configured, and exposes a tiny
// read-only HTTP API the viewer fetches from — so the graph list is inventoried live, with no
// `.dkg` export or build step.
//
// Config resolution (matches `index.ts` of the MCP server, plus a .mcp.json base):
//   1. Read the `deep-memory` server's `env` block out of .mcp.json (your existing provider setup).
//   2. Any DEEP_MEMORY_* variable already present in the environment overrides that base.
//
// The viewer loads on demand (like the UCM graph viewer): degree-ranked hubs first, then expands
// as the user explores — it never pulls the whole graph up front. Endpoints:
//   GET /api/repositories                         → [{ repositoryId, label, entityCount, relationshipCount, entityTypeBreakdown }]
//   GET /api/repositories/:id/hubs?limit=25       → { entities[], edges[], totalEntityCount, entityTypeCounts }  (seed)
//   GET /api/repositories/:id/explore/:entityId   → { center, layers, statistics }  (neighbourhood; ?depth ?limitPerType)
//   GET /api/repositories/:id/entities?search=&type=&limit=&offset=  → { items[], total, hasMore }  (search / type paging)
//   GET /api/repositories/:id/entity/:entityId?detailLevel=full      → full entity (detail panel)
//   GET /*                                        → static files from graph-viewer/  (one origin, no CORS)
//
// Run: node scripts/graph-viewer-server.mjs [--port 8137] [--mcp .mcp.json] [--server-key deep-memory]
//      (or: pnpm serve:graph-viewer).  Requires `pnpm build` first — it imports the built packages.

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { release } from 'node:os';
import {
  resolveConfig,
  buildDeepMemory,
  listRepositoriesWithStats,
  getHubs,
  exploreEntity,
  findEntitiesPage,
  getEntityDetail,
} from './lib/graph-data.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const viewerDir = join(repoRoot, 'graph-viewer');

// ── Args ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { port: 8137, mcp: join(repoRoot, '.mcp.json'), serverKey: 'deep-memory', open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--mcp') out.mcp = argv[++i];
    else if (a === '--server-key') out.serverKey = argv[++i];
    else if (a === '--no-open') out.open = false;
  }
  return out;
}

// ── Open the default browser (best-effort; the printed link is always the fallback) ─────────
function isWSL() {
  if (process.platform !== 'linux') return false;
  if (/microsoft|wsl/i.test(release())) return true;
  try { return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8')); } catch { return false; }
}

function openBrowser(url) {
  let cmd;
  let cmdArgs;
  if (process.platform === 'darwin') { cmd = 'open'; cmdArgs = [url]; }
  else if (process.platform === 'win32') { cmd = 'cmd'; cmdArgs = ['/c', 'start', '', url]; }
  // From WSL, reach the Windows default browser — xdg-open can't. explorer.exe handles http URLs.
  else if (isWSL()) { cmd = 'explorer.exe'; cmdArgs = [url]; }
  else { cmd = 'xdg-open'; cmdArgs = [url]; }
  try {
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
    // If the opener binary is missing (e.g. no xdg-open on a headless box), don't crash — the
    // link is printed to the console regardless.
    child.on('error', () => {});
    child.unref();
  } catch { /* ignore — link is printed regardless */ }
}

// ── Static file serving (sandboxed to graph-viewer/) ────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = normalize(join(viewerDir, pathname));
  // Path-traversal guard: must stay inside viewerDir.
  if (!filePath.startsWith(viewerDir)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(readFileSync(filePath));
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

// ── Wire up ─────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = resolveConfig(args.mcp, args.serverKey);
  const { deepMemory, storage, storageSetting } = buildDeepMemory(cfg);
  const repoCache = new Map();

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // Health probe — lets the static viewer detect that a live server is present.
    if (path === '/api/health') {
      sendJson(res, 200, { ok: true, storage: storageSetting });
      return;
    }

    if (path === '/api/repositories') {
      listRepositoriesWithStats(deepMemory, repoCache)
        .then((repos) => sendJson(res, 200, repos))
        .catch((err) => sendJson(res, 500, { error: err.message }));
      return;
    }

    // Initial seed — degree-ranked hubs + the edges among them + stats.
    const hubsMatch = path.match(/^\/api\/repositories\/([^/]+)\/hubs$/);
    if (hubsMatch) {
      const id = decodeURIComponent(hubsMatch[1]);
      const limit = Number(url.searchParams.get('limit')) || 25;
      getHubs(deepMemory, storage, storageSetting, repoCache, id, limit)
        .then((d) => sendJson(res, 200, d))
        .catch((err) => sendJson(res, 500, { error: err.message }));
      return;
    }

    // On-demand expansion — one entity's neighbourhood.
    const exploreMatch = path.match(/^\/api\/repositories\/([^/]+)\/explore\/([^/]+)$/);
    if (exploreMatch) {
      const id = decodeURIComponent(exploreMatch[1]);
      const entityId = decodeURIComponent(exploreMatch[2]);
      const depth = Number(url.searchParams.get('depth')) || 1;
      const limitPerType = Number(url.searchParams.get('limitPerType')) || 10;
      exploreEntity(deepMemory, repoCache, id, entityId, { depth, limitPerType })
        .then((d) => sendJson(res, 200, d))
        .catch((err) => sendJson(res, 500, { error: err.message }));
      return;
    }

    // Search by label, or page entities of a type (?search= or ?type=).
    const entitiesMatch = path.match(/^\/api\/repositories\/([^/]+)\/entities$/);
    if (entitiesMatch) {
      const id = decodeURIComponent(entitiesMatch[1]);
      const searchTerm = url.searchParams.get('search') || undefined;
      const type = url.searchParams.get('type');
      const limit = Number(url.searchParams.get('limit')) || 25;
      const offset = Number(url.searchParams.get('offset')) || 0;
      findEntitiesPage(deepMemory, repoCache, id, { searchTerm, entityTypes: type ? [type] : undefined, limit, offset })
        .then((d) => sendJson(res, 200, d))
        .catch((err) => sendJson(res, 500, { error: err.message }));
      return;
    }

    // Full detail for one entity (detail panel).
    const entityMatch = path.match(/^\/api\/repositories\/([^/]+)\/entity\/([^/]+)$/);
    if (entityMatch) {
      const id = decodeURIComponent(entityMatch[1]);
      const entityId = decodeURIComponent(entityMatch[2]);
      const detailLevel = url.searchParams.get('detailLevel') || 'full';
      getEntityDetail(deepMemory, repoCache, id, entityId, detailLevel)
        .then((d) => (d ? sendJson(res, 200, d) : sendJson(res, 404, { error: 'Entity not found' })))
        .catch((err) => sendJson(res, 500, { error: err.message }));
      return;
    }

    if (path.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Unknown API route' });
      return;
    }

    serveStatic(req, res);
  });

  const shutdown = async () => {
    server.close();
    try { await deepMemory.dispose(); } catch { /* best effort */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(args.port, () => {
    const url = `http://localhost:${args.port}/index.html`;
    console.log('');
    console.log(`  Deep Memory Graph Viewer  (storage: ${storageSetting})`);
    console.log('');
    console.log(`  ▶  ${url}`);
    console.log('');
    console.log(`     API: ${url.replace('/index.html', '/api/repositories')}`);
    console.log(`     Stop with Ctrl+C${args.open ? '' : '   (auto-open disabled)'}`);
    console.log('');
    if (args.open) openBrowser(url);
  });
}

main().catch((err) => {
  console.error('Failed to start graph-viewer server:', err);
  process.exit(1);
});
