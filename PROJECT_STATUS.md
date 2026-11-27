# Project status

**Progress:** The PostgreSQL store suite ignores `DATABASE_URL` and requires an explicit disposable `TEST_DATABASE_URL` (#32). Architecture and compliance work is tracked in #33–#40.

**Known limitation:** The repository has no configured formatter or linter. Style and unused imports require diff review; TypeScript checking and Bun tests are separate gates.

**Next action:** Implement the per-Server session and Slot acquisition (#33, #34) before changing Requested Emote and reconciliation flow.
