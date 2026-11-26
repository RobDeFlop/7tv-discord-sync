# AGENTS.md

## Agent skills

### Issue tracker

Issues are tracked in this repo's GitHub Issues through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five default triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Coding standards

Object-oriented TypeScript: classes, abstract base classes for ports, class hierarchies for domain entities, commands and errors. Read `docs/agents/coding-standards.md` before writing code.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
