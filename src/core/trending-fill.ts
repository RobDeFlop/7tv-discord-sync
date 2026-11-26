import { ServerQuotas, type SyncResult } from "../domain/index.ts";
import { ReconcileStep } from "./reconcile-step.ts";
import { SyncReport } from "./sync-report.ts";
import type { SyncedServer } from "./synced-server.ts";

/**
 * Fill the slots nothing of higher Precedence needs with the trending list, in
 * trending order. Never displaces anything. When Trending Fill is off, remove
 * every Trending Fill emote.
 */
export class TrendingFill extends ReconcileStep {
  /** How many trending emotes to ask 7TV for; enough to cover both quotas at the highest boost level. */
  private static readonly CANDIDATES = 150;

  public async run(synced: SyncedServer): Promise<SyncResult> {
    const report = new SyncReport();
    if (!synced.state.trending.enabled) {
      await this.removeAll(synced, report);
    } else {
      await this.fill(synced, report);
    }
    return report.toResult();
  }

  private async removeAll(synced: SyncedServer, report: SyncReport): Promise<void> {
    for (const managed of synced.state.managedOfTier("trending")) {
      const emoji = synced.emojiOf(managed);
      await synced.deleteEmoji(emoji);
      synced.state.removeManagedEmote(managed);
      report.change({ type: "deleted", name: emoji.name, reason: "trending-off" });
    }
  }

  private async fill(synced: SyncedServer, report: SyncReport): Promise<void> {
    const { state } = synced;
    const trending = await this.context.sevenTv.getTrending(state.trending.period, TrendingFill.CANDIDATES);
    for (const emote of trending) {
      if (state.findManaged(emote.id)) continue;
      const quota = ServerQuotas.quotaOf(emote.animated);
      const plan = await this.context.allocator.plan(synced, quota, "trending");
      if (!plan.ok || plan.displace) continue; // only genuinely free slots
      const image = await this.context.sevenTv.downloadImage(emote.id);
      if (!image.ok) continue; // retried on the next reconcile
      await this.context.allocator.place(synced, report, plan, emote, image.image, "trending", emote.name);
    }
  }
}
