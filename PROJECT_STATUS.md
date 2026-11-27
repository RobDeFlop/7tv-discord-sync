# Project status

**Progress:** Contributor rules are consolidated in [AGENTS.md](AGENTS.md). An architecture and AGENTS.md compliance review was filed as issues #32–#40, which are linked by native blocking dependencies.

**Blocker:** Bun auto-loads `.env`, so `bun test` runs the PostgreSQL store suite against the database in `.env`'s `DATABASE_URL`, migrating it and deleting rows. Until #32 lands, run the suite only when `.env` points at a disposable database.

**Known limitation:** The repository has no configured formatter or linter. Style and unused imports require diff review; TypeScript checking and Bun tests are separate gates.

**Next action:** Start with #32. #33, #34, #35 and #36 have no blockers and can proceed in parallel afterwards.
