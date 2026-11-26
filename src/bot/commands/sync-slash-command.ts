import type { ServerId } from "../../domain/index.ts";
import { BackgroundSyncCommand } from "../background-sync-command.ts";
import type { SlashRequest } from "../slash-request.ts";

/** /sync */
export class SyncSlashCommand extends BackgroundSyncCommand {
  public readonly path = "sync";
  public readonly description = "Sync this Server's emojis with 7TV now";

  protected async run(server: ServerId, _request: SlashRequest): Promise<string> {
    return this.queue(server);
  }
}
