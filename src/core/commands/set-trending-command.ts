import type { ServerId, SyncResult, TrendingPeriod } from "../../domain/index.ts";
import { SyncReport } from "../sync-report.ts";
import type { SyncContext } from "../sync-context.ts";
import { Command } from "./command.ts";

/** Turn Trending Fill on or off, optionally for a period. Not implemented yet. */
export class SetTrendingCommand extends Command {
  public constructor(
    private readonly enabled: boolean,
    private readonly period?: TrendingPeriod,
  ) {
    super();
  }

  public async execute(_server: ServerId, _context: SyncContext): Promise<SyncResult> {
    return SyncReport.single("error", 'Command "set-trending" is not implemented yet.');
  }
}
