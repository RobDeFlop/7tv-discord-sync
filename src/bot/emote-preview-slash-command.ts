import type { EmoteAddPreparation, SyncCore } from "../core/index.ts";
import type { ServerId } from "../domain/index.ts";
import type { EmoteAddPreviews } from "./emote-add-previews.ts";
import { SlashCommand } from "./slash-command.ts";
import type { SlashReply, SlashRequest } from "./slash-request.ts";

export abstract class EmotePreviewSlashCommand extends SlashCommand {
  public constructor(core: SyncCore, private readonly previews: EmoteAddPreviews) {
    super(core);
  }

  protected async run(serverId: ServerId, request: SlashRequest): Promise<SlashReply> {
    const preparation = await this.prepare(serverId, request);
    return this.previews.open(serverId, request.userId, this.path, preparation);
  }

  protected abstract prepare(serverId: ServerId, request: SlashRequest): Promise<EmoteAddPreparation>;
}
