import { UnlinkSourceSetCommand } from "../../core/index.ts";
import type { ServerId } from "../../domain/index.ts";
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

  protected run(server: ServerId, request: SlashRequest): Promise<string> {
    return this.apply(server, new UnlinkSourceSetCommand(this.requiredString(request, "emotes") === "keep"));
  }
}
