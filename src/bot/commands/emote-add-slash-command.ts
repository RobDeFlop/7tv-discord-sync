import { AddEmoteCommand } from "../../core/index.ts";
import type { ServerId } from "../../domain/index.ts";
import { SlashCommand, type SlashOption } from "../slash-command.ts";
import type { SlashRequest } from "../slash-request.ts";

/** /emote add <link> [name] */
export class EmoteAddSlashCommand extends SlashCommand {
  public readonly path = "emote add";
  public readonly description = "Add a 7TV emote to this Server";
  public override readonly options: ReadonlyArray<SlashOption> = [
    { name: "link", description: "7TV emote link", type: "string", required: true },
    { name: "name", description: "Name to use instead of the emote's own", type: "string" },
  ];

  protected run(server: ServerId, request: SlashRequest): Promise<string> {
    return this.apply(server, new AddEmoteCommand(this.requiredString(request, "link"), request.string("name") ?? undefined));
  }
}
