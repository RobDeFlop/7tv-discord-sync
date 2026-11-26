import type { ServerId } from "../../domain/index.ts";
import { FeedbackRouter } from "../feedback-router.ts";
import { SlashCommand } from "../slash-command.ts";
import type { SlashRequest } from "../slash-request.ts";

/** /sync */
export class SyncSlashCommand extends SlashCommand {
  public readonly path = "sync";
  public readonly description = "Sync this Server's emojis with 7TV now";

  protected async run(server: ServerId, _request: SlashRequest): Promise<string> {
    return FeedbackRouter.format((await this.core.reconcile(server)).feedback);
  }
}
