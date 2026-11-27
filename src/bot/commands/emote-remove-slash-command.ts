import type { APIEmbed } from "discord.js";
import { FeedbackRouter } from "../feedback-router.ts";
import type { ServerId } from "../../domain/index.ts";
import { SlashCommand, type SlashOption } from "../slash-command.ts";
import type { SlashRequest } from "../slash-request.ts";

/** /emote remove <name> */
export class EmoteRemoveSlashCommand extends SlashCommand {
  public readonly path = "emote remove";
  public readonly description = "Remove an emoji this bot created";
  public override readonly options: ReadonlyArray<SlashOption> = [
    { name: "name", description: "Emoji name", type: "string", required: true },
  ];

  protected override async run(server: ServerId, request: SlashRequest): Promise<APIEmbed> {
    const { feedback } = await this.core.removeEmote(server, this.requiredString(request, "name"));
    return FeedbackRouter.card(feedback);
  }
}
