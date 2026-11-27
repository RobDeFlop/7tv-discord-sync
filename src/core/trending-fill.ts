import type { SevenTvPort } from "../ports/index.ts";
import { ReconcileStep } from "./reconcile-step.ts";
import type { SlotAcquisition } from "./slot-acquisition.ts";
import type { SyncReport } from "./sync-report.ts";
import type { SyncedServer } from "./synced-server.ts";

/**
 * Fill the slots nothing of higher Precedence needs with the trending list, in
 * trending order. Never displaces anything. When Trending Fill is off, remove
 * every Trending Fill emote.
 */
export class TrendingFill extends ReconcileStep {
  /** How many trending emotes to ask 7TV for; enough to cover both quotas at the highest boost level. */
  private static readonly CANDIDATES = 150;

  public constructor(private readonly sevenTv: SevenTvPort, private readonly allocator: SlotAcquisition) {
    super();
  }

  public override async run(synced: SyncedServer, report: SyncReport): Promise<void> {
    if (!synced.state.trending.enabled) {
      await this.removeAll(synced, report);
    } else {
      await this.fill(synced, report);
    }
  }

  private async removeAll(synced: SyncedServer, report: SyncReport): Promise<void> {
    for (const managed of synced.state.managedOfTier("trending")) {
      await synced.removeManaged(managed, report, "trending-off");
    }
  }

  private async fill(synced: SyncedServer, report: SyncReport): Promise<void> {
    const { state } = synced;
    const trending = await this.sevenTv.getTrending(state.trending.period, TrendingFill.CANDIDATES);
    for (const emote of trending) {
      if (state.findManaged(emote.id)) continue;
      const outcome = await this.allocator.acquire(synced, report, { emote, tier: "trending" });
      if (outcome.kind === "failed") throw outcome.error;
    }
  }
}
