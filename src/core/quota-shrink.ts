import { ServerQuotas, type Quota, type SyncResult } from "../domain/index.ts";
import { ReconcileStep } from "./reconcile-step.ts";
import { SyncReport } from "./sync-report.ts";
import type { SyncedServer } from "./synced-server.ts";

/**
 * When a quota holds more emojis than its limit (the boost level dropped), give
 * slots up by Precedence: Trending Fill first, then the Source Set, then, only
 * when nothing else is left, Requested Emotes (their request is dropped too, or
 * the next reconcile would be unable to keep it anyway). Reserved Slots are
 * never touched. Runs before the steps that fill slots.
 */
export class QuotaShrink extends ReconcileStep {
  public async run(synced: SyncedServer): Promise<SyncResult> {
    const report = new SyncReport();
    const quotas = await synced.quotas();
    for (const quota of ServerQuotas.ALL) {
      await this.shrink(synced, report, quota, synced.usedIn(quota) - quotas.limit());
    }
    return report.toResult();
  }

  private async shrink(synced: SyncedServer, report: SyncReport, quota: Quota, excess: number): Promise<void> {
    if (excess <= 0) return;
    const { state } = synced;
    for (const managed of state.lowestPrecedence(quota, excess)) {
      const emoji = synced.emojiOf(managed);
      await synced.deleteEmoji(emoji);
      state.removeManagedEmote(managed);
      if (managed.tier === "requested") state.removeRequestedEmote(managed.sevenTvEmoteId);
      report.change({ type: "deleted", name: emoji.name, reason: "boost-lost" });
      report.say(
        "warning",
        `${emoji.name} (${managed.tier}) was removed because the Server's ${quota} emoji limit dropped with its boost level.`,
      );
    }
  }
}
