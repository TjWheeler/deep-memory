import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'providers/index': 'src/providers/index.ts',
    'types/index': 'src/types/index.ts',
    'testing/conformance': 'src/providers-builtin/conformance.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  external: ['vitest'],
  define: {
    '__DEEP_MEMORY_VERSION__': JSON.stringify(pkg.version),
  },
});
