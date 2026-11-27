import type { SyncObserver } from "../../core/index.ts";
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

  protected override async schedule(server: ServerId, request: SlashRequest, observer: SyncObserver): Promise<void> {
    await this.core.linkSourceSet(server, this.requiredString(request, "link"), observer);
  }
}
