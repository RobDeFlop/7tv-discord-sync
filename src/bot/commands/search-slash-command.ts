import type { EmoteAddPreparation } from "../../core/index.ts";
import type { ServerId } from "../../domain/index.ts";
import { EmotePreviewSlashCommand } from "../emote-preview-slash-command.ts";
import type { SlashOption } from "../slash-command.ts";
import type { SlashRequest } from "../slash-request.ts";

/** /search <name> */
export class SearchSlashCommand extends EmotePreviewSlashCommand {
  public readonly path = "search";
  public readonly description = "Find a 7TV emote by exact name and preview it before adding";
  public override readonly options: ReadonlyArray<SlashOption> = [
    { name: "name", description: "Exact 7TV emote name", type: "string", required: true },
  ];

  protected prepare(serverId: ServerId, request: SlashRequest): Promise<EmoteAddPreparation> {
    return this.core.prepareEmoteSearch(serverId, this.requiredString(request, "name"));
  }
}
