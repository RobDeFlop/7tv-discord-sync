import type { SyncObserver } from "../../core/index.ts";
import type { ServerId } from "../../domain/index.ts";
import { BackgroundSyncCommand } from "../background-sync-command.ts";
import type { SlashRequest } from "../slash-request.ts";

/** /sync */
export class SyncSlashCommand extends BackgroundSyncCommand {
  public readonly path = "sync";
  public readonly description = "Queue a sync of this Server's emojis with 7TV";

  protected override schedule(server: ServerId, _request: SlashRequest, observer: SyncObserver): Promise<unknown> {
    return this.core.reconcile(server, observer);
  }
}
