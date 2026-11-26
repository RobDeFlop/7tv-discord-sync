import type { ServerId, ServerStatus, TierUsage } from "../../domain/index.ts";
import { SlashCommand } from "../slash-command.ts";
import type { SlashRequest } from "../slash-request.ts";

/** /status */
export class StatusSlashCommand extends SlashCommand {
  public readonly path = "status";
  public readonly description = "Show slot usage, settings, problems and pending writes";

  protected async run(server: ServerId, _request: SlashRequest): Promise<string> {
    return StatusSlashCommand.render(await this.core.status(server), Date.now());
  }

  private static render(status: ServerStatus, now: number): string {
    const lines = [
      ...(status.manageExpressions ? [] : ["Error: I am missing the Manage Expressions permission, so I cannot change emojis."]),
      StatusSlashCommand.usage("Static", status.quotas.static),
      StatusSlashCommand.usage("Animated", status.quotas.animated),
      `Linked 7TV user: ${status.linkedUserId ?? "none"}`,
      `Trending Fill: ${status.trending.enabled ? `on (${status.trending.period})` : "off"}`,
      `Log channel: ${status.logChannelId ? `<#${status.logChannelId}>` : "not set"}`,
      StatusSlashCommand.queue(status, now),
    ];
    if (status.problems.length > 0) {
      lines.push("Problems:", ...status.problems.map((p) => `- ${p.message}`));
    }
    return lines.join("\n");
  }

  private static usage(label: string, u: TierUsage): string {
    const t = u.byTier;
    return `${label}: ${u.used}/${u.used + u.free} (reserved ${t.reserved}, requested ${t.requested}, source ${t.source}, trending ${t.trending})`;
  }

  private static queue(status: ServerStatus, now: number): string {
    const { pending, retryingAt } = status.writeQueue;
    if (pending === 0) return "Write queue: idle";
    const base = `Write queue: ${pending} ${pending === 1 ? "write" : "writes"} pending`;
    if (retryingAt === null) return base;
    const seconds = Math.max(0, Math.ceil((retryingAt - now) / 1000));
    return `${base}, rate limited by Discord, retrying in ${seconds}s`;
  }
}
