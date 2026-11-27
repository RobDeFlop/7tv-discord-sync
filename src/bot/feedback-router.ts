import type { APIEmbed } from "discord.js";
import type { SyncCore, SyncObserver, SyncUpdate } from "../core/index.ts";
import type { FeedbackMessage, ServerId, SyncResult } from "../domain/index.ts";
import { Logger, LogLevel } from "./logger.ts";
import type { SlashRequest } from "./slash-request.ts";

/** Where background sync feedback is posted. */
export abstract class LogChannel {
  /** Null if the bot's effective channel permission could not be verified. */
  public abstract hasEmbedLinks(channelId: string): Promise<boolean | null>;
  public abstract send(channelId: string, embeds: ReadonlyArray<APIEmbed>): Promise<void>;
}

/** Formats feedback and routes background sync reports. */
export class FeedbackRouter {
  private static readonly MAX_EMBED_DESCRIPTION = 4096;
  private static readonly MAX_TOTAL_EMBED_TEXT = 6000;
  // Discord interaction tokens expire after 15 minutes; leave a margin for request latency.
  private static readonly REPLY_WINDOW_MS = 14 * 60_000 + 55_000;
  private readonly delivered = new WeakMap<SyncUpdate, Promise<void>>();

  public constructor(
    private readonly core: Pick<SyncCore, "logChannelId">,
    private readonly logChannel: LogChannel,
  ) {}

  /** Command feedback is shown to the admin as an ephemeral reply. */
  public static format(feedback: ReadonlyArray<FeedbackMessage>): string {
    if (feedback.length === 0) return "Done.";
    return feedback.map((f) => FeedbackRouter.line(f)).join("\n");
  }

  /** Deliver every shared update to the log channel at most once if one or more replies need fallback. */
  public deliverUpdate(server: ServerId, update: SyncUpdate, privateFallback = false): Promise<void> {
    if (update.kind === "cancelled") return Promise.resolve();
    const existing = this.delivered.get(update);
    if (existing) return existing;
    const result = { ...update.result, feedback: FeedbackRouter.updateFeedback(update, privateFallback) };
    if (!result.feedback.length) return Promise.resolve();
    const delivery = this.deliver(server, result);
    this.delivered.set(update, delivery);
    return delivery;
  }

  /** Give one invocation a private result while its interaction is editable; otherwise route the shared update. */
  public privateReply(request: SlashRequest): SyncObserver {
    let recipient: SlashRequest | undefined = request;
    const deadline = request.createdAt + FeedbackRouter.REPLY_WINDOW_MS;
    const timer = setTimeout(() => { recipient = undefined; }, Math.max(0, deadline - Date.now()));
    timer.unref();
    const release = (): void => {
      recipient = undefined;
      clearTimeout(timer);
    };
    return async (server, update, setting) => {
      if (recipient && Date.now() < deadline) {
        try {
          const feedback = FeedbackRouter.updateFeedback(update, true);
          await recipient.editOriginal(FeedbackRouter.format([...(setting ?? []), ...feedback]));
          return;
        } catch (error) {
          Logger.write(LogLevel.error, `sync_reply_edit_failed operation=edit_original server=${Logger.field(server)} ${Logger.failure(error)}`);
        } finally {
          if (update.kind !== "paused") release();
        }
      }
      release();
      await this.deliverUpdate(server, update, true);
    };
  }

  /** Feedback goes to the configured log channel if any; status is available regardless. */
  public async deliver(server: ServerId, result: SyncResult): Promise<void> {
    if (result.feedback.length === 0) return;
    let operation = "load_log_channel";
    try {
      const channelId = await this.core.logChannelId(server);
      if (!channelId) return;
      operation = "send_log_embed";
      await this.logChannel.send(channelId, FeedbackRouter.embeds(result.feedback));
    } catch (error) {
      Logger.write(LogLevel.error, `feedback_delivery_failed operation=${operation} server=${Logger.field(server)} ${Logger.failure(error)}`);
    }
  }

  private static updateFeedback(update: SyncUpdate, includeEmpty: boolean): FeedbackMessage[] {
    const { changes, feedback } = update.result;
    const failed = feedback.some((message) => message.level === "error");
    if (update.kind === "cancelled" || (!changes.length && (!includeEmpty || failed))) return feedback;
    const summary = update.kind === "paused" ? `${changes.length} emoji changes before the pause.`
      : failed ? `Sync ended after ${changes.length} emoji changes.`
      : `Sync complete: ${changes.length} emoji changes.`;
    const details = changes.slice(0, 10).map((change): FeedbackMessage => {
      const text = change.type === "created" ? `Added ${change.name}.`
        : change.type === "deleted" ? `Removed ${change.name}.`
        : change.type === "reserved" ? `Kept ${change.name} as a Reserved Slot.`
        : `Renamed ${change.from} to ${change.to}.`;
      return { level: "info", text };
    });
    return [{ level: "info", text: summary }, ...feedback, ...details];
  }

  private static embeds(feedback: ReadonlyArray<FeedbackMessage>): APIEmbed[] {
    const grouped: Record<FeedbackMessage["level"], string[]> = { info: [], warning: [], error: [] };
    for (const { level, text } of feedback) grouped[level].push(text);
    const sections = ([
      ["Sync results", grouped.info],
      ["Sync warnings", grouped.warning],
      ["Sync errors", grouped.error],
    ] as const).filter(([, lines]) => lines.length > 0);
    // Share Discord's per-message embed limit so a long result cannot hide warnings or errors.
    const budget = Math.floor(FeedbackRouter.MAX_TOTAL_EMBED_TEXT / sections.length);
    return sections.map(([title, lines]) => {
      const description = lines.join("\n");
      const limit = Math.min(FeedbackRouter.MAX_EMBED_DESCRIPTION, budget - title.length);
      return { title, description: description.length > limit ? `${description.slice(0, limit - 1)}…` : description };
    });
  }

  private static line(f: FeedbackMessage): string {
    const prefix = f.level === "info" ? "" : f.level === "warning" ? "Warning: " : "Error: ";
    return `${prefix}${f.text}`;
  }
}
