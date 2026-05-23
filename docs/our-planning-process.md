# Planning Process

This document describes how we plan and execute non-trivial work. The process is technology-agnostic and applies regardless of the layer being touched (HTTP triggers, queue handlers, mapping engines, infrastructure-as-code, pipelines, etc.).

## When to Create a Plan

Create an implementation plan when a feature:

- Touches **3 or more components** (e.g. an HTTP trigger, a queue, a downstream API client, configuration, infrastructure), **or**
- Spans **multiple concerns** (code + infrastructure + configuration + observability), **or**
- Introduces a new **architectural pattern**, dependency, or external integration, **or**
- Has **acceptance criteria** that cannot be verified by a single test in a single file.

Small, contained changes (renaming a setting, fixing a single bug, tightening a log message) do not need a plan — just do them.

## Plan Structure

Every plan follows this skeleton:

```
# Feature Name
Ticket / SOW reference, scope summary, target environment, branch

## Execution Process
Phase-based progress tracker with review gates

## Design Decisions
Agreed choices with rationale (interface shape, retry strategy, configuration surface, deferrals)

## Implementation Details
Phases with steps, doc references, code guidance, file paths

## Related Tickets / Out-of-Scope
Cross-references with scope notes (covered, deferred, explicitly out of scope)
```

## Phases, Not Steps

Group tightly coupled work into **phases**. Each phase produces a reviewable unit that can be built, run, and reasoned about on its own. Typical phase patterns:

| Phase pattern | Typical content |
|--------------|-----------------|
| Foundation | Solution structure, DI container, base interfaces, shared models |
| Infrastructure-as-Code | Bicep modules, parameter files, role assignments |
| Configuration | App settings shape, Key Vault references, validation at startup |
| Inbound surface | HTTP triggers, request validation, auth |
| Messaging | Queues / topics, envelope schema, enqueue path |
| Processing | Triggers, handler dispatch, retry engine |
| Integrations | External API clients (auth, transport, response classification) |
| Domain logic | Mapping engines, transforms, business rules |
| Observability | Structured logging, custom metrics, dependency tracking, alerts |
| Pipeline | Build, test, deploy stages, environment promotion |
| Verification | Build check, unit tests, integration smoke test |

Adjust phases to fit the feature. Not every feature touches every layer.

A phase is **not** a single file or a single commit — it is a coherent slice of work that delivers something testable.

## Review Gates

- Work **one phase at a time**.
- After completing a phase: mark progress in the plan, **stop**, and ask for review.
- Do **not** begin the next phase until review is approved.
- If implementation reveals that the plan was wrong, **update the plan first**, get the change approved, then continue.

The review gate is the single most important rule in this document. The point is not bureaucracy — it is to catch direction errors early, before they compound across phases.

## Required Reading

Every conversation that touches implementation must load these documents at the start:

- `docs/README.md` — index of available docs
- `docs/development-instructions.md` — coding standards, repo conventions, tooling
- `docs/our-planning-process.md` — this file

These are the minimum. Additional docs are loaded per phase (see below).

## Doc Loading Per Phase

Each phase in a plan **specifies which docs to load** for that phase. Only load what is relevant to the current phase — do not front-load every doc at conversation start. Phase-specific docs go in the plan like this:

```
### Phase N: Phase Name
**Load docs:** `docs/relevant-guide.md`, `docs/other-guide.md`
```

Examples of phase-targeted docs you might load:

- An infrastructure-as-code phase: load the IaC conventions doc, the naming standards doc.
- A messaging phase: load the queue/envelope conventions doc.
- An external-API integration phase: load the auth and retry conventions doc.
- An observability phase: load the logging and metrics standards doc.

## Code Guidance in Plans

Plans contain enough detail that an engineer (or Claude) can execute them without re-deriving design decisions:

- **Contracts first** — interfaces, method signatures, message envelopes, configuration shape.
- **File paths** — where new files go, which existing files are modified.
- **Patterns to follow** — reference existing sibling files (e.g. "follow the pattern of `ExistingHandler.cs`").
- **Verbatim content for greenfield files** — Bicep modules, configuration JSON, fixed schemas. These have no drift risk because the file does not yet exist.

Code snippets in plans are **guidance, not scripts**. Always check the current state of touched files before editing — the codebase moves under the plan.

## Validation Before Execution

Before writing code for a phase, validate the plan against the current state of the repository:

- Do interface signatures match the actual base types / abstractions they extend?
- Do naming conventions match what is already in use (casing, prefixes, suffixes)?
- Are configuration keys consistent across code, app settings, and documentation?
- Are dependencies (NuGet packages, framework versions, runtime targets) compatible with what is already in the solution?
- Do the planned file paths fit the existing project layout?
- For infrastructure changes: do resource names follow the existing convention and fit naming-length limits?
- For external API calls: are auth scopes and permissions already established, or do they need to be requested/configured first?

If validation reveals drift, update the plan **before** writing code.

## Plan Lifecycle

Plans are **transient documents**. They guide a single feature from design through delivery, then become historical records.

- Live plans live in `plans/`.
- Once a plan's feature has shipped (merged + deployed + verified), move the plan to `plans/archive/`.
- Plans are **not maintained** after the feature ships. Source-of-truth for shipped behaviour is the code, the tests, and the runbook — not the plan that built it.

## Anti-Patterns to Avoid

- **All-at-once implementation.** Writing every phase before getting any phase reviewed. This defeats the gate.
- **Plan as documentation.** Treating the plan as the long-term description of how the system works. It is not — it is a build artefact.
- **Front-loading all docs.** Loading every doc up front "in case" instead of per-phase. Wastes context, dilutes signal.
- **Skipping the validation step.** Executing yesterday's plan against today's repo without checking what changed.
- **Phase boundaries that are not reviewable.** A phase that ends mid-handler, with code that does not compile, cannot be reviewed. Phase boundaries must be coherent stopping points.
