import { escapeMarkdown, type APIEmbed, type APIEmbedField } from "discord.js";
import type { SyncCore } from "../../core/index.ts";
import type { Problem, ServerId, ServerStatus, TierUsage, WriteQueueProgress } from "../../domain/index.ts";
import { EmbedStyle } from "../embed-style.ts";
import { FeedbackRouter, type LogChannel } from "../feedback-router.ts";
import { SlashCommand } from "../slash-command.ts";

/** /status */
export class StatusSlashCommand extends SlashCommand {
  private static readonly MAX_FIELD_VALUE = 1024;
  private static readonly MAX_PROBLEM_LENGTH = 240;

  public readonly path = "status";
  public readonly description = "Show whether action is needed, slot usage, settings and pending writes";

  public constructor(core: SyncCore, private readonly logChannel: LogChannel) {
    super(core);
  }

  protected async run(server: ServerId): Promise<APIEmbed> {
    const status = await this.core.status(server);
    const hasEmbedLinks = status.logChannelId ? await this.logChannel.hasEmbedLinks(status.logChannelId) : null;
    // Only warn when the permission check confirms that Embed Links is missing.
    return StatusSlashCommand.render(status, hasEmbedLinks ?? true);
  }

  private static render(status: ServerStatus, hasEmbedLinks: boolean): APIEmbed {
    const channel = status.logChannelId ? `<#${status.logChannelId}>` : null;
    const actions: string[] = [];
    if (!status.manageExpressions) {
      actions.push("Missing **Manage Expressions**. Grant it to the bot’s role and run `/sync` to resume emoji updates.");
    }
    if (channel && !hasEmbedLinks) {
      actions.push(`Missing **Embed Links** in ${channel}. Grant it to the bot in that channel to restore sync feedback.`);
    }
    if (status.problems.some((problem) => problem.kind !== "renamed-with-suffix")) {
      actions.push("Review the sync problems below.");
    }

    const user = status.linkedUserId;
    // Inline fields lay out in rows of three: slot usage and the queue, then the settings.
    return EmbedStyle.card({
      tone: actions.length ? "warning" : "success",
      title: actions.length ? "Action needed" : "No action needed",
      description: actions.map((action) => `• ${action}`).join("\n"),
      fields: [
        StatusSlashCommand.usage("Static Slots", status.quotas.static),
        StatusSlashCommand.usage("Animated Slots", status.quotas.animated),
        { name: "Write queue", value: StatusSlashCommand.queue(status.writeQueue), inline: true },
        { name: "Linked 7TV user", value: user ? `[${user}](https://7tv.app/users/${user})` : "Not linked", inline: true },
        { name: "Trending Fill", value: `${status.trending.enabled ? "On" : "Off"} · ${status.trending.period}`, inline: true },
        { name: "Log channel", value: channel ?? "Not set", inline: true },
        ...(status.lastSync ? [{ name: "Latest sync", value: StatusSlashCommand.latestSync(status.lastSync) }] : []),
        ...(status.problems.length ? [{ name: "Problems", value: StatusSlashCommand.problems(status.problems) }] : []),
      ],
    });
  }

  private static latestSync(last: NonNullable<ServerStatus["lastSync"]>): string {
    const lines = [`**${last.changeCount}** emoji ${last.changeCount === 1 ? "change" : "changes"}.`];
    if (last.retryAt !== undefined) lines.push(`Resume scheduled ${EmbedStyle.relativeTime(last.retryAt)}.`);
    if (last.feedback.length) lines.push(FeedbackRouter.format(last.feedback));
    return lines.join("\n").slice(0, StatusSlashCommand.MAX_FIELD_VALUE).toWellFormed();
  }

  private static usage(name: string, usage: TierUsage): APIEmbedField {
    const { used, free, byTier } = usage;
    return {
      name,
      inline: true,
      value: [
        `${EmbedStyle.bar(used, used + free)} **${used}**/${used + free}`,
        `Reserved Slots: ${byTier.reserved}`,
        `Requested Emotes: ${byTier.requested}`,
        `Source Set: ${byTier.source}`,
        `Trending Fill: ${byTier.trending}`,
      ].join("\n"),
    };
  }

  private static queue({ pending, retryingAt }: WriteQueueProgress): string {
    if (pending === 0) return "Idle";
    const base = `${pending} ${pending === 1 ? "write" : "writes"} pending`;
    if (retryingAt === null) return base;
    return `${base}. Rate limited by Discord; retrying ${EmbedStyle.relativeTime(retryingAt)}.`;
  }

  private static problems(problems: ReadonlyArray<Problem>): string {
    let entries = "";
    let result = "";
    for (const [index, { message }] of problems.entries()) {
      const text = message.replace(/\s+/g, " ").trim() || "No details available.";
      const max = StatusSlashCommand.MAX_PROBLEM_LENGTH;
      const detail = text.length <= max ? text : `${text.slice(0, max - 1).toWellFormed()}…`;
      const next = `${entries}${entries ? "\n" : ""}- ${escapeMarkdown(detail)}`;
      const omitted = problems.length - index - 1;
      const suffix = omitted > 0 ? `\n${omitted} more omitted.` : "";
      if (next.length + suffix.length > StatusSlashCommand.MAX_FIELD_VALUE) break;
      entries = next;
      result = next + suffix;
    }
    return result;
  }
}
