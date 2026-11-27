import type { SyncCore, SyncObserver } from "../core/index.ts";
import type { ServerId } from "../domain/index.ts";
import type { FeedbackRouter } from "./feedback-router.ts";
import { Logger, LogLevel } from "./logger.ts";
import { SlashCommand } from "./slash-command.ts";
import type { SlashRequest } from "./slash-request.ts";

/** Acknowledge before dispatching; the core owns when the sync runs. */
export abstract class BackgroundSyncCommand extends SlashCommand {
  public constructor(core: SyncCore, private readonly feedback: FeedbackRouter) {
    super(core);
  }

  protected override async run(server: ServerId, request: SlashRequest): Promise<void> {
    await request.reply({ title: "Sync queued", description: "This private reply will be updated with the result." });
    const observer = this.feedback.privateReply(request);
    void this.schedule(server, request, observer).catch(async (error: unknown) => {
      Logger.write(LogLevel.error, `sync_failed operation=request server=${Logger.field(server)} ${Logger.failure(error)}`);
      await observer(server, {
        kind: "finished",
        result: { changes: [], feedback: [{ level: "error", text: "Could not queue this sync. Try again in a moment." }] },
      });
    });
  }

  protected abstract schedule(server: ServerId, request: SlashRequest, observer: SyncObserver): Promise<unknown>;
}
