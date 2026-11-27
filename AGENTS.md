# Working on 7TV Discord Sync

This file is the authority for repository-wide contributor and agent rules. Instructions below are mandatory unless marked **prefer**. Tool-specific instruction files link here; add a directory guide only for a verified local exception, and link it from here.

## Before changing anything

Read the relevant issue for acceptance criteria and progress, and the nearest implementation, callers and tests. Verify the behavior against code rather than treating an issue note or example as a spec. Use the single [glossary](GLOSSARY.md) in code, tests, issues and docs. Read relevant decisions under `docs/adr/` if present; surface conflicts before changing an accepted decision.

Fix the cause with the smallest change that satisfies the requirement. Reuse existing commands, policies and infrastructure. **Prefer** a direct implementation over a new abstraction; extract shared behavior when callers need the same rule. Do not add speculative extension points, dependencies, unrelated cleanup or workarounds. Remove code, imports and comments made obsolete by the change. A stub, hardcoded success or unimplemented path is outstanding work, not a completed feature.

## Architecture and domain invariants

| Owner | Responsibility and boundary |
| --- | --- |
| `src/bot/` | Discord interactions, authorization, reply visibility, events and feedback delivery. Use `SlashCommand` subclasses and the registry; send business operations to the core. Wire production dependencies in `src/bot/application.ts`. |
| `src/core/` | Reconcile Server state and execute commands using domain objects and injected ports. Each `Command` subclass implements `execute`; do not introduce a command-kind switch. |
| `src/domain/` | Own identity, quotas, slot precedence, Server state, snapshots and domain feedback. Keep I/O and SDK types out. |
| `src/ports/` | Define abstract classes in project vocabulary. Production adapters and in-memory fakes extend the same contracts. Keep SDK responses and database rows behind the ports. |
| `src/adapters/`, `src/image/` | Translate Discord, 7TV, PostgreSQL and image formats at the edge. Map external data to domain types here, not in reconciliation or slash replies. |

- Dependencies point inward: core may use ports and domain; neither imports the bot, concrete adapters or test fakes. Avoid circular imports, including through barrel exports. Compose collaborators by constructor injection; use inheritance for the established port, slot occupant, command, slash-command and error families.
- Sync is one-way, 7TV → Discord. Scope reads and writes per Server. Only modify Managed Emotes; never rename, delete or displace a Reserved Slot. Apply domain Precedence within each static or animated quota, not across quotas.
- Route overlapping commands and automatic syncs through the shared `ServerLock`; keep unrelated Servers independent. Preserve the Discord write queue's ordering and rate-limit handling. Await network, storage and image operations; bound fan-out and give detached work an explicit error handler. Never block the event loop waiting for I/O or a retry.

## TypeScript and contracts

- Preserve strict compilation, checked indexed access and explicit overrides. Use `import type` for type-only dependencies. Accept untrusted input as `unknown` and narrow it at the boundary. Do not substitute `any`, a non-null assertion, a double cast or a compiler suppression for validation. If a library forces an assertion, isolate it at the adapter, explain the invariant and test it.
- Import the owning SDK, port or domain type rather than cloning it. Derive shared shapes from the canonical schema or use generated contracts when available; do not invent a parallel API generator for this bot. For a Drizzle schema change, run `bun run db:generate`, inspect the SQL and include the migration and metadata together. Test migration and snapshot round-tripping against PostgreSQL.
- Put behavior on classes; use a private or static method for an owning class's helper, not a factory returning a bag of functions. Declare member visibility; default fields to `private readonly`. Return read-only collections or copies. Mutate `ServerState` through methods and persist via `toSnapshot()` / `fromSnapshot()`.
- Keep IDs, names and simple unions as aliases. Use interfaces or types for behavior-free records and an immutable class for a multi-field domain value or one with behavior. Use implicit enum values unless storage or a wire contract requires explicit values.

## Failures and diagnostics

Translate expected service failures into typed errors at the boundary. Use `DomainError.toFeedback()` for actionable admin feedback; keep SDK exceptions out of user replies. Narrow caught values, preserve the cause when wrapping an exception, and retain enough context to identify the failed operation. Recover only when the caller can distinguish the degraded outcome from success. Never silently catch an error.

Use `Logger.write` with the appropriate `LogLevel` for bot diagnostics. Its message argument is a string: give events stable names and include safe named fields, e.g. `sync_failed server=<id> operation=reconcile`. Keep raw request bodies, authorization headers, Discord tokens and database URLs out of logs, feedback, test output and status notes.

## Verification and handoff

1. Test features and fixes through observable behavior. Put `bun:test` cases beside the implementation. Drive core behavior through its public API with the port fakes in `src/testing/`. For a fix, add a case that fails without it; cover the affected success, boundary and failure paths (e.g. quota exhaustion, permission loss or partial Discord writes).
2. For code changes run `bun run typecheck` and the affected tests, e.g. `bun test ./src/core/slots.test.ts`. Before declaring the suite green, run `bun test --timeout 30000` with `TEST_DATABASE_URL` set to a **disposable test database**. The store suite migrates and deletes test state; it ignores `DATABASE_URL` and skips when `TEST_DATABASE_URL` is unset. Never use an operator database.
3. Run configured format and lint checks when available. Currently neither is configured: match adjacent TypeScript style, review the diff for unused imports and dead code, and run `git diff --check` for whitespace. That command is not a linter. For docs-only edits, verify paths, links, commands and behavior claims against their owners; runtime tests are not required unless the edit changes an executable example that needs them.
4. For packaging or deployment changes, use the matching checks in `.github/workflows/test-image.yml`, `scripts/test-compose.sh` or `scripts/test-install-bundle.sh`; verify the operator-facing artifact, not just the source. Never weaken a check, skip a failure or regenerate expected output merely to pass. Report commands actually run, failures, skips, and what remains unverified.
5. Document public contracts (inputs, outcomes and failure semantics) and explain *why* non-obvious policy or ordering exists. Update operator docs and examples with behavior changes; record significant architectural decisions under `docs/adr/` when settled. Record progress, blockers and next actions on the relevant issue, not in a repository file.

## Issues and triage

Use GitHub Issues via `gh` for specs, requests and tracking. Read the issue body and comments (`gh issue view <n> --comments`); search before filing. PRs are not a feature-request triage surface. In mixed references, distinguish a PR from an issue before updating it.

| Triage label | Apply when |
| --- | --- |
| `needs-triage` | A maintainer must evaluate the issue. |
| `needs-info` | Work awaits information from the reporter. |
| `ready-for-agent` | Requirements are sufficient for unattended implementation. |
| `ready-for-human` | Implementation requires a human. |
| `wontfix` | The project will not act on it. |

For wayfinding, keep one `wayfinder:map` issue with notes, decisions and open questions. Track tickets as native sub-issues labelled `wayfinder:<type>` (`research`, `prototype`, `grilling`, `task`) and blockers as native issue dependencies. Where unavailable, list children in the map with `Part of #<parent>` in each child and `Blocked by: #<n>` in blocked tickets. Claim the first open, unassigned child in map order with no open blockers by assigning the driving developer. On resolution, comment the answer, close the ticket and link the decision in the map.
