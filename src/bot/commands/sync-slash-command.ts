import type { ServerId } from "../../domain/index.ts";
import { BackgroundSyncCommand } from "../background-sync-command.ts";
import type { SlashReply, SlashRequest } from "../slash-request.ts";

/** /sync */
export class SyncSlashCommand extends BackgroundSyncCommand {
  public readonly path = "sync";
  public readonly description = "Queue a sync of this Server's emojis with 7TV";

  protected async run(server: ServerId, _request: SlashRequest): Promise<SlashReply> {
    this.queue(server);
    return {
      title: "Sync queued",
      description: "Check `/status` for pending writes or the configured log channel for results.",
    };
  }
}
