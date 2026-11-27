# Keep Server sync scheduling in core

Commands and automatic syncs share one Server lock and session so that successful Discord writes stay owned by the bot even when a later write fails. Setting Commands save before joining the scheduler: a coalesced run sees committed settings, and a retry starts from saved state instead of replaying a Command.

The scheduler uses one concurrency limit for all triggers. It releases the Server lock during backoff and keeps the waiting replies attached to the retry. The bot handles private reply edits and log delivery; core retains a bounded latest summary for `/status` until restart. This avoids coupling reconciliation to an interaction token or storing those tokens alongside Server state.

See [#33](https://github.com/RobDeFlop/7tv-discord-sync/issues/33), [#39](https://github.com/RobDeFlop/7tv-discord-sync/issues/39), and [#40](https://github.com/RobDeFlop/7tv-discord-sync/issues/40).
