import { SetTrendingCommand, type SyncObserver } from "../../core/index.ts";
import type { ServerId, TrendingPeriod } from "../../domain/index.ts";
import { BackgroundSyncCommand } from "../background-sync-command.ts";
import type { SlashOption } from "../slash-command.ts";
import type { SlashRequest } from "../slash-request.ts";

/** /trending <on|off> [period] */
export class TrendingSlashCommand extends BackgroundSyncCommand {
  private static readonly PERIODS = ["day", "week", "month", "all-time"] as const satisfies readonly TrendingPeriod[];
  public readonly path = "trending";
  public readonly description = "Fill free slots with trending 7TV emotes";
  public override readonly options: ReadonlyArray<SlashOption> = [
    { name: "state", description: "Turn Trending Fill on or off", type: "string", required: true, choices: ["on", "off"] },
    {
      name: "period",
      description: "Trending period (default: week)",
      type: "string",
      choices: TrendingSlashCommand.PERIODS,
    },
  ];

  protected override async schedule(server: ServerId, request: SlashRequest, observer: SyncObserver): Promise<void> {
    const state = request.option("state");
    const period = request.option("period");
    if (state !== "on" && state !== "off") {
      await TrendingSlashCommand.reject(server, observer, "Choose on or off for Trending Fill.");
    } else if (period !== undefined && !TrendingSlashCommand.isPeriod(period)) {
      await TrendingSlashCommand.reject(server, observer, "Invalid Trending Fill period. Choose day, week, month, or all-time.");
    } else {
      await this.core.apply(server, new SetTrendingCommand(state === "on", period), observer);
    }
  }

  private static isPeriod(value: unknown): value is TrendingPeriod {
    return TrendingSlashCommand.PERIODS.some((period) => period === value);
  }

  private static reject(server: ServerId, observer: SyncObserver, text: string): Promise<void> {
    return observer(server, { kind: "finished", result: { changes: [], feedback: [{ level: "error", text }] } });
  }
}
