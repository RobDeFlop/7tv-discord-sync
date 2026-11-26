import type { ServerId } from "../../domain/index.ts";
import { BackgroundSyncCommand } from "../background-sync-command.ts";
import type { SlashOption } from "../slash-command.ts";
import type { SlashRequest } from "../slash-request.ts";

/** /set link <7tv link> */
export class SetLinkSlashCommand extends BackgroundSyncCommand {
  public readonly path = "set link";
  public readonly description = "Mirror a 7TV user's active emote set to this Server";
  public override readonly options: ReadonlyArray<SlashOption> = [
    { name: "link", description: "7TV user link", type: "string", required: true },
  ];

  protected async run(server: ServerId, request: SlashRequest): Promise<string> {
    const command = await this.core.prepareSourceLink(this.requiredString(request, "link"));
    this.queue(server, command);
    return "Sync queued. Check /status for progress or the configured log channel for the result.";
  }
}
