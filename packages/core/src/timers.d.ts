// Minimal timer declarations for environments that provide setTimeout (Node, browsers, Deno, etc.)
// Avoids pulling in full DOM or Node type libraries while keeping the core package environment-agnostic.

declare function setTimeout(callback: () => void, ms?: number): unknown;
