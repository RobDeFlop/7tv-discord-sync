import type { APIEmbed } from "discord.js";
import type { FeedbackMessage, ServerId, SyncResult } from "../domain/index.ts";
import type { StorePort } from "../ports/index.ts";
import { logger } from "./logger.ts";

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
   * Background sync feedback goes to the Server's log channel if one is set. Problems are
   * recorded in the Server's state by the core either way, so without a channel they show in /status.
   */
  public async deliver(server: ServerId, result: SyncResult): Promise<void> {
    if (result.feedback.length === 0) return;
    try {
      const channelId = (await this.store.load(server)).logChannelId;
      if (!channelId) return;
      await this.logChannel.send(channelId, FeedbackRouter.embeds(result.feedback));
    } catch (err) {
      logger.error(`Could not deliver feedback for ${server}:`, err);
    }
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
