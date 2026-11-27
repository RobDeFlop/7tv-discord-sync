import type { APIEmbed } from "discord.js";
import { UnlinkSourceSetCommand } from "../../core/index.ts";
import type { ServerId } from "../../domain/index.ts";
import { FeedbackRouter } from "../feedback-router.ts";
import { SlashCommand, type SlashOption } from "../slash-command.ts";
import type { SlashRequest } from "../slash-request.ts";

/** /set unlink <delete|keep> */
export class SetUnlinkSlashCommand extends SlashCommand {
  public readonly path = "set unlink";
  public readonly description = "Stop mirroring the linked 7TV user";
  public override readonly options: ReadonlyArray<SlashOption> = [
    {
      name: "emotes",
      description: "Delete the mirrored emotes, or keep them as Reserved Slots?",
      type: "string",
      required: true,
      choices: ["delete", "keep"],
    },
  ];

  protected async run(server: ServerId, request: SlashRequest): Promise<APIEmbed> {
    const emotes = request.option("emotes");
    if (emotes !== "delete" && emotes !== "keep") return FeedbackRouter.refusal("Choose whether to delete or keep the Source Set's emotes.");
    return this.apply(server, new UnlinkSourceSetCommand(emotes === "keep"));
  }
}
