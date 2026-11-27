import type { EmoteAddPreparation } from "../../core/index.ts";
import type { ServerId } from "../../domain/index.ts";
import { EmotePreviewSlashCommand } from "../emote-preview-slash-command.ts";
import type { SlashOption } from "../slash-command.ts";
import type { SlashRequest } from "../slash-request.ts";

/** /emote add <link> */
export class EmoteAddSlashCommand extends EmotePreviewSlashCommand {
  public readonly path = "emote add";
  public readonly description = "Preview a 7TV emote before adding it to this Server";
  public override readonly options: ReadonlyArray<SlashOption> = [
    { name: "link", description: "7TV emote link", type: "string", required: true },
  ];

  protected prepare(serverId: ServerId, request: SlashRequest): Promise<EmoteAddPreparation> {
    return this.core.prepareEmoteAdd(serverId, this.requiredString(request, "link"));
  }
}
