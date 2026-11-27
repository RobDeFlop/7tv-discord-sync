import type { EmoteAddPreparation, SyncCore } from "../core/index.ts";
import type { ServerId } from "../domain/index.ts";
import type { EmoteAddPreviews } from "./emote-add-previews.ts";
import type { ServerLock } from "./server-lock.ts";
import { SlashCommand } from "./slash-command.ts";
import type { SlashReply, SlashRequest } from "./slash-request.ts";

export abstract class EmotePreviewSlashCommand extends SlashCommand {
  protected override readonly needsLock = false;

  public constructor(core: SyncCore, lock: ServerLock, private readonly previews: EmoteAddPreviews) {
    super(core, lock);
  }

  protected async run(serverId: ServerId, request: SlashRequest): Promise<SlashReply> {
    const preparation = await this.prepare(serverId, request);
    return this.previews.open(serverId, request.userId, this.path, preparation);
  }

  protected abstract prepare(serverId: ServerId, request: SlashRequest): Promise<EmoteAddPreparation>;
}
