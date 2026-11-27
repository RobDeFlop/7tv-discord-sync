import { ServerQuotas, type Quota } from "../domain/index.ts";
import { ReconcileStep } from "./reconcile-step.ts";
import type { SyncReport } from "./sync-report.ts";
import type { SyncedServer } from "./synced-server.ts";

/**
 * When a quota holds more emojis than its limit (the boost level dropped), give
 * slots up by Precedence: Trending Fill first, then the Source Set, then, only
 * when nothing else is left, Requested Emotes (their request is dropped too, or
 * the next reconcile would be unable to keep it anyway). Reserved Slots are
 * never touched. Runs before the steps that fill slots.
 */
export class QuotaShrink extends ReconcileStep {
  public override async run(synced: SyncedServer, report: SyncReport): Promise<void> {
    const quotas = await synced.quotas();
    for (const quota of ServerQuotas.ALL) {
      await this.shrink(synced, report, quota, synced.usedIn(quota) - quotas.limit());
    }
  }

  private async shrink(synced: SyncedServer, report: SyncReport, quota: Quota, excess: number): Promise<void> {
    if (excess <= 0) return;
    const { state } = synced;
    for (const managed of state.lowestPrecedence(quota, excess)) {
      const emoji = await synced.removeManaged(managed, report, "boost-lost");
      report.say(
        "warning",
        `${emoji.name} (${managed.tier}) was removed because the Server's ${quota} emoji limit dropped with its boost level.`,
      );
    }
  }
}
