import type { ServerId, SyncResult, TrendingPeriod } from "../../domain/index.ts";
import type { SyncContext } from "../sync-context.ts";
import { Command } from "./command.ts";

/** Turn Trending Fill on or off, optionally for a period (default: week), then reconcile. */
export class SetTrendingCommand extends Command {
  public constructor(
    private readonly enabled: boolean,
    private readonly period?: TrendingPeriod,
  ) {
    super();
  }

  public async execute(server: ServerId, context: SyncContext): Promise<SyncResult> {
    const state = await context.store.load(server);
    state.setTrending(this.enabled, this.period);
    await context.store.save(server, state);
    const result = await context.reconciler.reconcile(server);
    const { period } = state.trending;
    const text = this.enabled ? `Trending Fill is on (${period}).` : "Trending Fill is off.";
    return { changes: result.changes, feedback: [{ level: "info", text }, ...result.feedback] };
  }
}
