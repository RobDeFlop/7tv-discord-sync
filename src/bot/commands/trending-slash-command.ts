import { SetTrendingCommand } from "../../core/index.ts";
import type { ServerId, TrendingPeriod } from "../../domain/index.ts";
import { SlashCommand, type SlashOption } from "../slash-command.ts";
import type { SlashRequest } from "../slash-request.ts";

/** /trending <on|off> [period] */
export class TrendingSlashCommand extends SlashCommand {
  public readonly path = "trending";
  public readonly description = "Fill free slots with trending 7TV emotes";
  public override readonly options: ReadonlyArray<SlashOption> = [
    { name: "state", description: "Turn Trending Fill on or off", type: "string", required: true, choices: ["on", "off"] },
    {
      name: "period",
      description: "Trending period (default: week)",
      type: "string",
      choices: ["day", "week", "month", "all-time"],
    },
  ];

  protected run(server: ServerId, request: SlashRequest): Promise<string> {
    const enabled = this.requiredString(request, "state") === "on";
    const period = (request.string("period") ?? undefined) as TrendingPeriod | undefined;
    return this.apply(server, new SetTrendingCommand(enabled, period));
  }
}
