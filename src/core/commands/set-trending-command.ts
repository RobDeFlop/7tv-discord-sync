import type { TrendingPeriod } from "../../domain/index.ts";
import type { SyncedServer } from "../synced-server.ts";
import type { SyncReport } from "../sync-report.ts";
import { Command } from "./command.ts";

/** Turn Trending Fill on or off and request a sync. */
export class SetTrendingCommand extends Command {
  public override readonly requestsSync = true;

  public constructor(
    private readonly enabled: boolean,
    private readonly period?: TrendingPeriod,
  ) {
    super();
  }

  public override async execute(synced: SyncedServer, report: SyncReport): Promise<void> {
    synced.state.setTrending(this.enabled, this.period);
    const { period } = synced.state.trending;
    report.say("info", this.enabled ? `Trending Fill is on (${period}).` : "Trending Fill is off.");
  }
}
