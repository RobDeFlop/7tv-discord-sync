import { SetTrendingCommand, type SyncCore } from "../../core/index.ts";
import type { ServerId, TrendingPeriod } from "../../domain/index.ts";
import { RateLimitError } from "../../ports/discord-port.ts";
import type { GatewayEvents } from "../gateway-events.ts";
import type { ServerLock } from "../server-lock.ts";
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

  public constructor(core: SyncCore, lock: ServerLock, private readonly events: GatewayEvents) {
    super(core, lock);
  }

  protected async run(server: ServerId, request: SlashRequest): Promise<string> {
    const enabled = this.requiredString(request, "state") === "on";
    const period = (request.stringOption("period") ?? undefined) as TrendingPeriod | undefined;
    try {
      return await this.apply(server, new SetTrendingCommand(enabled, period));
    } catch (error) {
      if (!(error instanceof RateLimitError)) throw error;
      return this.events.resumeAfterRateLimit(server, error);
    }
  }
}
