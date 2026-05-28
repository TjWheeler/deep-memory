# Contributing to @utaba/deep-memory

We welcome contributions to this project. By submitting a contribution (pull request, issue, patch, or any other form), you agree to the terms of our [Contributor License Agreement](CLA.md).

## Contributor License Agreement

All contributions to this project are subject to the [CLA](CLA.md). The CLA grants Tim Wheeler a broad, royalty-free license to your contributions, including the right to relicense under different terms. This is standard practice for open-source projects and ensures the project can evolve without legal complications.

**By opening a pull request, you confirm that you have read and agree to the CLA.**

## Getting Started

1. Fork the repository
2. Create a branch from `development` (not `main`)
3. Make your changes
4. Run `pnpm typecheck && pnpm test` to verify
5. Open a pull request against `development`

## Code Conventions

- Zero runtime dependencies in `packages/core`
- No `utils/` folders — place files in the domain folder they belong to
- All thrown errors must use the hierarchy in `src/core/errors.ts`
- Tests are co-located next to their source as `*.test.ts`
- TypeScript strict mode is enabled

## Releasing Changes

Versions are managed by [Changesets](https://github.com/changesets/changesets). If your PR changes the behaviour of any published package, add a changeset describing your change:

```bash
pnpm changeset
```

You will be prompted to select affected packages and a bump level (`patch` / `minor` / `major`). The six published packages are in a fixed group, so selecting any one of them bumps the whole group together — pick the package whose change is most prominent.

Commit the generated `.changeset/*.md` file as part of your PR. The PR template's checklist has a reminder.

Skip the changeset for docs-only, test-only, or internal CI changes — those do not need a release.

Full release flow (for maintainers): [Publishing Guide](docs/publishing-guide.md).

## License

This project is licensed under the [Apache License 2.0](LICENSE).
