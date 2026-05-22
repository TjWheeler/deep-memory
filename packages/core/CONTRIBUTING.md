# Contributing to @utaba/deep-memory

## Local Development Setup

### Prerequisites

- Node.js 22 or 24 (the supported LTS pair — CI tests both)
- pnpm 9+

### Clone and build

```bash
git clone <repo-url>
cd deep-memory
npm install
npm run build
```

### npm link (for consuming from another local project)

```bash
# In the deep-memory repo:
npm link

# In the consuming project:
npm link @utaba/deep-memory
```

After running `npm install` in the consuming project, you'll need to re-run `npm link @utaba/deep-memory` as npm install resets symlinks.

### Watch mode

```bash
npm run dev   # tsup --watch — rebuilds on file changes
```

Changes are immediately available in linked projects via the symlink.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Build CJS + ESM + declaration files via tsup |
| `npm run dev` | Watch mode build |
| `npm test` | Run all tests (vitest) |
| `npm run test:watch` | Watch mode tests |
| `npm run test:coverage` | Tests with coverage report |
| `npm run typecheck` | Type-check without emitting (tsc --noEmit) |

## Project Structure

```
src/
├── index.ts                    # Public API barrel export
├── core/                       # DeepMemory, MemoryRepository, EventBus, ProvenanceTracker, errors
├── vocabulary/                 # Vocabulary validation, governance, deduplication, diffing
├── entities/                   # EntityManager, ID generation
├── relationships/              # RelationshipManager, GraphTraversal
├── search/                     # SearchOrchestrator
├── portability/                # Export/Import, MigrationEngine
├── providers/                  # Provider interfaces (StorageProvider, etc.)
├── providers-builtin/          # InMemoryStorageProvider, conformance tests
├── types/                      # All TypeScript type definitions
└── validation/                 # Property validation
```

## Testing

Tests are co-located with source files (`*.test.ts`). Run with:

```bash
npm test
```

### Provider Conformance Tests

If you're implementing a custom `StorageProvider`, use the conformance test suite:

```typescript
import { runStorageProviderConformanceTests } from '@utaba/deep-memory/testing';

runStorageProviderConformanceTests(() => new YourProvider());
```

## Coding Conventions

- **TypeScript strict mode** — `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` are all enabled.
- **No utils/ folders** — place files in the domain folder they belong to.
- **Provider pattern** — new functionality that requires external services should be behind a provider interface.
- **Typed errors** — all thrown errors must use the error hierarchy in `src/core/errors.ts`.

## Pull Requests

1. Create a branch from `development`
2. Make your changes with tests
3. Run `npm run typecheck && npm test` before submitting
4. Keep PRs focused — one feature or fix per PR
