# Project status

**Progress:** #32–#40 are implemented on `fix/issues-32-40`. Store tests require an explicit disposable `TEST_DATABASE_URL`. Commands and reconciliation share a Server session, and background sync scheduling follows [ADR 0001](docs/adr/0001-core-owned-server-sync.md).

**Known limitation:** The repository has no configured formatter or linter. Style and unused imports require diff review; TypeScript checking and Bun tests are separate gates.

**Bot replies:** Every reply and log post is a styled card from `src/bot/embed-style.ts`. `FeedbackRouter` builds the sync and command cards, and `/status` and the emote preview set their own layouts. Without Embed Links, `DetailedSlashReply` turns a card into text.

**Next action:** Review the combined change before merging. In Discord, confirm that queued commands edit their original private replies and that an expired reply falls back to the log channel or `/status`. Check the cards in a real Server, in both light and dark themes and with Embed Links removed. The tests do not cover how they render.
