import type { APIEmbed, APIEmbedField } from "discord.js";
import type { SyncCore, SyncObserver, SyncUpdate } from "../core/index.ts";
import type { Change, FeedbackMessage, ServerId, SyncResult } from "../domain/index.ts";
import { EmbedStyle, type EmbedCard } from "./embed-style.ts";
import { Logger, LogLevel } from "./logger.ts";
import type { SlashRequest } from "./slash-request.ts";

/** Where background sync feedback is posted. */
export abstract class LogChannel {
  /** Null if the bot's effective channel permission could not be verified. */
  public abstract hasEmbedLinks(channelId: string): Promise<boolean | null>;
  public abstract send(channelId: string, embeds: ReadonlyArray<APIEmbed>): Promise<void>;
}

type CardHeading = Omit<EmbedCard, "description" | "fields">;

/** Formats feedback as cards and routes background sync reports. */
export class FeedbackRouter {
  private static readonly MAX_CHANGE_LIST = 512;
  private static readonly SEVERITY_ORDER = ["error", "warning", "info"] as const;
  // Discord interaction tokens expire after 15 minutes; leave a margin for request latency.
  private static readonly REPLY_WINDOW_MS = 14 * 60_000 + 55_000;
  private readonly delivered = new WeakMap<SyncUpdate, Promise<void>>();

  public constructor(
    private readonly core: Pick<SyncCore, "logChannelId">,
    private readonly logChannel: LogChannel,
  ) {}

  /** Feedback as plain lines, for a field inside another card. */
  public static format(feedback: ReadonlyArray<FeedbackMessage>): string {
    if (feedback.length === 0) return "Done.";
    return feedback.map((message) => EmbedStyle.line(message)).join("\n");
  }

  /** One command's result; the most severe message sets the colour and title. */
  public static card(feedback: ReadonlyArray<FeedbackMessage>): APIEmbed {
    const tone = EmbedStyle.tone(feedback);
    const title = tone === "error" ? "Couldn't complete that" : tone === "warning" ? "Done, with warnings" : "Done";
    return FeedbackRouter.compose({ tone, title }, [], feedback);
  }

  /** An error card for a request the bot will not or could not carry out. */
  public static refusal(text: string): APIEmbed {
    return FeedbackRouter.card([{ level: "error", text }]);
  }

  /** Deliver every shared update to the log channel at most once if one or more replies need fallback. */
  public deliverUpdate(server: ServerId, update: SyncUpdate, privateFallback = false): Promise<void> {
    if (update.kind === "cancelled") return Promise.resolve();
    const { changes, feedback } = update.result;
    // A routine sync that changed nothing stays quiet; a reply that could not be edited is always answered.
    if (!privateFallback && !changes.length && !feedback.length) return Promise.resolve();
    const existing = this.delivered.get(update);
    if (existing) return existing;
    const delivery = this.post(server, FeedbackRouter.syncCard(update, privateFallback));
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
          await recipient.editOriginal(FeedbackRouter.syncCard(update, true, setting));
          return;
        } catch (error) {
          Logger.write(LogLevel.error, `sync_reply_edit_failed operation=edit_original server=${Logger.field(server)} ${Logger.failure(error)}`);
        } finally {
          if (update.kind !== "paused") release();
        }
      }
      release();
      await this.deliverUpdate(server, update, true);
      // The shared result is posted once, but settings can differ between two invocations.
      if (update.kind === "finished" && setting?.length) {
        await this.post(server, FeedbackRouter.card(setting));
      }
    };
  }

  /** Feedback goes to the configured log channel if any; status is available regardless. */
  public async deliver(server: ServerId, result: SyncResult): Promise<void> {
    if (result.feedback.length === 0) return;
    await this.post(server, FeedbackRouter.syncCard({ kind: "finished", result }, false));
  }

  private async post(server: ServerId, embed: APIEmbed): Promise<void> {
    let operation = "load_log_channel";
    try {
      const channelId = await this.core.logChannelId(server);
      if (!channelId) return;
      operation = "send_log_embed";
      // Log posts are read later, so they carry when the sync happened; private replies already show it.
      await this.logChannel.send(channelId, [{ ...embed, timestamp: new Date().toISOString() }]);
    } catch (error) {
      Logger.write(LogLevel.error, `feedback_delivery_failed operation=${operation} server=${Logger.field(server)} ${Logger.failure(error)}`);
    }
  }

  /**
   * The outcome leads: title and colour, a one-line summary, then problems before routine notes.
   * `summarizeEmpty` says "up to date" for a sync someone asked for; a background report omits it.
   */
  private static syncCard(update: SyncUpdate, summarizeEmpty: boolean, setting: readonly FeedbackMessage[] = []): APIEmbed {
    const { changes } = update.result;
    const feedback = [...setting, ...update.result.feedback];
    const failed = feedback.some(({ level }) => level === "error");
    const summarize = update.kind !== "cancelled" && (changes.length > 0 || (summarizeEmpty && !failed));
    const count = `**${changes.length}** emoji ${changes.length === 1 ? "change" : "changes"}`;
    const fields = FeedbackRouter.changeFields(changes);
    if (update.kind === "cancelled") return FeedbackRouter.compose({ tone: "neutral", title: "Sync cancelled" }, fields, feedback);
    if (failed) {
      const heading: CardHeading = { tone: "error", title: changes.length ? "Sync stopped" : "Couldn't complete that" };
      return FeedbackRouter.compose(heading, fields, feedback, summarize ? [`Stopped after ${count}.`] : []);
    }
    if (update.kind === "paused") {
      const resume = `Resuming ${EmbedStyle.relativeTime(update.retryAt)}.`;
      const lead = summarize ? `${count} so far. ${resume}` : resume;
      return FeedbackRouter.compose({ tone: "warning", icon: "⏸️", title: "Sync paused" }, fields, feedback, [lead]);
    }
    const tone = EmbedStyle.tone(feedback);
    const title = tone === "warning" ? "Sync finished with warnings" : "Sync complete";
    // "Up to date" would contradict warnings about emotes that were skipped.
    const empty = tone === "success" ? "Everything is already up to date." : "No emoji changes.";
    const lead = !summarize ? [] : changes.length ? [`${count}.`] : [empty];
    return FeedbackRouter.compose({ tone, title }, fields, feedback, lead);
  }

  private static changeFields(changes: ReadonlyArray<Change>): APIEmbedField[] {
    const added: string[] = [];
    const removed: string[] = [];
    const reserved: string[] = [];
    const renamed: string[] = [];
    for (const change of changes) {
      if (change.type === "created") added.push(`\`${change.name}\``);
      else if (change.type === "deleted") removed.push(`\`${change.name}\``);
      else if (change.type === "reserved") reserved.push(`\`${change.name}\``);
      else renamed.push(`\`${change.from}\` → \`${change.to}\``);
    }
    const groups = [
      ["➕ Added", added, ", "],
      ["➖ Removed", removed, ", "],
      ["📌 Kept as Reserved Slots", reserved, ", "],
      ["✏️ Renamed", renamed, "\n"],
    ] as const;
    return groups.filter(([, items]) => items.length > 0).map(([name, items, separator]) => ({
      name: `${name} (${items.length})`,
      value: EmbedStyle.lines(items, FeedbackRouter.MAX_CHANGE_LIST, separator),
      inline: separator !== "\n",
    }));
  }

  /** Each severity present gets an equal share of the description, so a long result cannot hide warnings or errors. */
  private static compose(
    heading: CardHeading,
    fields: ReadonlyArray<APIEmbedField>,
    feedback: ReadonlyArray<FeedbackMessage>,
    lead: ReadonlyArray<string> = [],
  ): APIEmbed {
    const levels = FeedbackRouter.SEVERITY_ORDER.filter((level) => feedback.some((message) => message.level === level));
    // With one severity the title already carries its icon; repeat it per line only to tell mixed lines apart.
    const groups = levels.map((level) => feedback.filter((message) => message.level === level)
      .map((message) => levels.length > 1 ? EmbedStyle.line(message) : message.text));
    const intro = lead.join("\n");
    const available = Math.min(EmbedStyle.MAX_DESCRIPTION, EmbedStyle.MAX_TOTAL - EmbedStyle.overhead(heading.title, fields))
      - intro.length - 2 - groups.length;
    const share = Math.floor(available / Math.max(1, groups.length));
    const body = groups.map((lines) => EmbedStyle.lines(lines, share)).join("\n");
    const description = [intro, body].filter(Boolean).join("\n\n");
    return EmbedStyle.card({ ...heading, description, fields });
  }
}
