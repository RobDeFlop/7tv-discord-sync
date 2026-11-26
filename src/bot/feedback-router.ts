import type { FeedbackMessage, ServerId, SyncResult } from "../domain/index.ts";
import type { StorePort } from "../ports/index.ts";

/** Where automatic-sync feedback is posted. */
export abstract class LogChannel {
  public abstract send(channelId: string, text: string): Promise<void>;
}

/** Turns feedback into text and decides where it goes. */
export class FeedbackRouter {
  public constructor(
    private readonly store: StorePort,
    private readonly logChannel: LogChannel,
  ) {}

  /** Command feedback is shown to the admin as an ephemeral reply. */
  public static format(feedback: ReadonlyArray<FeedbackMessage>): string {
    if (feedback.length === 0) return "Done.";
    return feedback.map((f) => FeedbackRouter.line(f)).join("\n");
  }

  /**
   * Automatic-sync feedback goes to the Server's log channel if one is set. Problems are
   * recorded in the Server's state by the core either way, so without a channel they show in /status.
   */
  public async deliver(server: ServerId, result: SyncResult): Promise<void> {
    if (result.feedback.length === 0) return;
    try {
      const channelId = (await this.store.load(server)).logChannelId;
      if (!channelId) return;
      await this.logChannel.send(channelId, FeedbackRouter.format(result.feedback));
    } catch (err) {
      console.error(`Could not deliver feedback for ${server}:`, err);
    }
  }

  private static line(f: FeedbackMessage): string {
    const prefix = f.level === "info" ? "" : f.level === "warning" ? "Warning: " : "Error: ";
    return `${prefix}${f.text}`;
  }
}
