import { LinkSourceSetCommand } from "../../core/index.ts";
import type { ServerId } from "../../domain/index.ts";
import { SlashCommand, type SlashOption } from "../slash-command.ts";
import type { SlashRequest } from "../slash-request.ts";

/** /set link <7tv link> */
export class SetLinkSlashCommand extends SlashCommand {
  public readonly path = "set link";
  public readonly description = "Mirror a 7TV user's active emote set to this Server";
  public override readonly options: ReadonlyArray<SlashOption> = [
    { name: "link", description: "7TV user link", type: "string", required: true },
  ];

  protected run(server: ServerId, request: SlashRequest): Promise<string> {
    return this.apply(server, new LinkSourceSetCommand(this.requiredString(request, "link")));
  }
}
