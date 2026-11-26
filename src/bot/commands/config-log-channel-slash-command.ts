import { ConfigureLogChannelCommand } from "../../core/index.ts";
import type { ServerId } from "../../domain/index.ts";
import { SlashCommand, type SlashOption } from "../slash-command.ts";
import type { SlashRequest } from "../slash-request.ts";

/** /config log-channel <channel> */
export class ConfigLogChannelSlashCommand extends SlashCommand {
  public readonly path = "config log-channel";
  public readonly description = "Choose where automatic sync messages are posted";
  public override readonly options: ReadonlyArray<SlashOption> = [
    { name: "channel", description: "Text channel for sync messages", type: "channel", required: true },
  ];

  protected run(server: ServerId, request: SlashRequest): Promise<string> {
    return this.apply(server, new ConfigureLogChannelCommand(this.requiredString(request, "channel")));
  }
}
