/**
 * Deterministic extractor for documentation nodes and their references to source.
 *
 * Collects markdown from docs/**, the root-level *.md (README, quickstart-*, CONTRIBUTING…),
 * and each package's README. For each doc it captures the title (first H1, else filename), the
 * explicit markdown links to .ts/.tsx source files (the strong DOCUMENTS signal), and the
 * PascalCase symbol tokens in prose (the soft MENTIONS signal). Fenced code blocks are stripped
 * first so example snippets pollute neither signal. No LLM — pure text/markdown parsing. Edge
 * resolution against modelled entities happens in rebuild.ts.
 */
import fs from 'fs';
import path from 'path';

export interface DocInfo {
  title: string;
  /** Doc file path relative to the repo root. */
  filePath: string;
  /** Repo-relative paths of .ts/.tsx source files explicitly linked from this doc. */
  linkedPaths: string[];
  /** Distinct symbol-like tokens (PascalCase / IPascalCase) appearing in prose. */
  mentionedSymbols: string[];
}

const FENCED_CODE = /```[\s\S]*?```/g;
const MD_LINK = /\[[^\]]*\]\(([^)\s]+)/g; // capture the target up to whitespace/closing paren
const SYMBOL_TOKEN = /\b[A-Z][A-Za-z0-9]+\b/g; // PascalCase + IPascalCase

function walkMarkdown(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
}

/** docs/**, root-level *.md, and each package's top-level README — deduped. */
function collectDocFiles(repoRoot: string): string[] {
  const files = new Set<string>();
  const fromDocs: string[] = [];
  walkMarkdown(path.join(repoRoot, 'docs'), fromDocs);
  for (const f of fromDocs) files.add(f);

  for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) files.add(path.join(repoRoot, entry.name));
  }

  const packagesDir = path.join(repoRoot, 'packages');
  if (fs.existsSync(packagesDir)) {
    for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const readme = path.join(packagesDir, entry.name, 'README.md');
      if (fs.existsSync(readme)) files.add(readme);
    }
  }

  return [...files];
}

export function extractDocs(repoRoot: string): DocInfo[] {
  const docs: DocInfo[] = [];

  for (const absPath of collectDocFiles(repoRoot)) {
    const raw = fs.readFileSync(absPath, 'utf8');
    const docDir = path.dirname(absPath);

    const title = raw.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() ?? path.basename(absPath, '.md');

    // Strip fenced code blocks so example snippets contribute to neither links nor mentions.
    const prose = raw.replace(FENCED_CODE, ' ');

    // Strong: explicit markdown links to .ts/.tsx source files, resolved to repo-relative paths.
    const linkedPaths = new Set<string>();
    for (const m of prose.matchAll(MD_LINK)) {
      const target = m[1]!.split('#')[0]!; // drop #Lxx anchors
      if (!target || /^(https?:|mailto:|#)/.test(target)) continue;
      if (!/\.tsx?$/.test(target)) continue;
      const rel = path.relative(repoRoot, path.resolve(docDir, target));
      if (!rel.startsWith('..')) linkedPaths.add(rel);
    }

    // Soft: distinct symbol-like tokens in prose. Inline `code` keeps its content (backticks
    // are not word chars, so the token is still matched).
    const mentionedSymbols = new Set<string>(prose.match(SYMBOL_TOKEN) ?? []);

    docs.push({
      title,
      filePath: path.relative(repoRoot, absPath),
      linkedPaths: [...linkedPaths],
      mentionedSymbols: [...mentionedSymbols],
    });
  }

  return docs;
}
