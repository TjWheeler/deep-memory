/**
 * Deterministic extractor for the MCP tool surface.
 *
 * Scans the two MCP servers' tool classes via ts-morph — packages/mcp-server/src/tools/**
 * (memory_* tools) and packages/indexer-mcp-server/src/tools/** (indexing_* tools) — and reads
 * each tool's wire name from its `get name() { return '...'; }` literal. No module execution,
 * no LLM. ADVERTISES edges (server → tool) are built in rebuild.ts.
 *
 * `domain` groups the tool (the memory tools' subfolder, or `indexing`); `mutates` flags write
 * tools by wire name, for read-only reasoning.
 */
import path from 'path';
import { Project, SyntaxKind } from 'ts-morph';

export type McpServerKind = 'memory' | 'indexer';

export interface ToolInfo {
  /** Wire name — the node label, e.g. memory_create_entities. */
  wireName: string;
  /** Implementing class name, e.g. CreateEntitiesTool. */
  className: string;
  /** Source file path relative to the repo root. */
  filePath: string;
  /** Which server advertises it. */
  server: McpServerKind;
  /** Functional grouping (memory subfolder, or `indexing`). */
  domain: string;
  /** True if the tool writes/mutates state. */
  mutates: boolean;
}

const MUTATING = /(^|_)(create|update|delete|remove|import|ensure|reembed|propose|init|execute|stop)(_|$)/;

/** Read a class's `get name()` string-literal return value, if it has one. */
function readWireName(cls: import('ts-morph').ClassDeclaration): string | undefined {
  const getter = cls.getGetAccessor('name');
  if (!getter) return undefined;
  const ret = getter.getFirstDescendantByKind(SyntaxKind.ReturnStatement);
  return ret?.getExpression()?.asKind(SyntaxKind.StringLiteral)?.getLiteralValue();
}

/** The memory tool's grouping = the folder under tools/ (entity, graph, …); indexer = `indexing`. */
function domainOf(relPath: string, server: McpServerKind): string {
  if (server === 'indexer') return 'indexing';
  const parts = relPath.split(path.sep);
  const i = parts.indexOf('tools');
  return i >= 0 && parts.length > i + 2 ? parts[i + 1]! : 'memory';
}

export function extractTools(repoRoot: string): ToolInfo[] {
  const project = new Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true });
  project.addSourceFilesAtPaths(path.join(repoRoot, 'packages/mcp-server/src/tools/**/*.ts'));
  project.addSourceFilesAtPaths(path.join(repoRoot, 'packages/indexer-mcp-server/src/tools/**/*.ts'));

  const tools: ToolInfo[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();
    if (/\.(test|spec)\.ts$/.test(filePath)) continue;
    const rel = path.relative(repoRoot, filePath);
    const server: McpServerKind = rel.includes(`${path.sep}indexer-mcp-server${path.sep}`) ? 'indexer' : 'memory';

    for (const cls of sourceFile.getClasses()) {
      const wireName = readWireName(cls);
      if (!wireName) continue; // not a tool — base classes / helpers have no `get name()` literal
      const className = cls.getName();
      if (!className) continue;
      tools.push({
        wireName,
        className,
        filePath: rel,
        server,
        domain: domainOf(rel, server),
        mutates: MUTATING.test(wireName),
      });
    }
  }

  return tools;
}
