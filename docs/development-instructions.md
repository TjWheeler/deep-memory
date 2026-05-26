# Development Instructions

Used to track important codebase rules.

## No plan / phase references in code

Never write `Phase N` (or any other transient plan label) into comments, error messages, test `describe(...)` strings, or doc strings inside `packages/` — plan numbering is transitional and meaningless once the plan is merged.

## Author a changeset when a plan completes

When a plan touches a published package's runtime behaviour, ask before authoring a changeset and confirm the bump level before declaring the plan complete. See [publishing-guide.md](publishing-guide.md) for the release flow, bump-level guidance, and changeset file format — read it when this rule applies.
