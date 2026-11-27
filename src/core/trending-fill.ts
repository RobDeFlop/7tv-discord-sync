import { ServerQuotas } from "../domain/index.ts";
import type { SevenTvPort } from "../ports/index.ts";
import { ImageFailure } from "./image-failure.ts";
import { NameCollision } from "./name-collision.ts";
import { ReconcileStep } from "./reconcile-step.ts";
import type { SlotAllocator } from "./slot-allocator.ts";
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

  public constructor(private readonly sevenTv: SevenTvPort, private readonly allocator: SlotAllocator) {
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
      if (ImageFailure.confirmKnown(state, emote.id)) continue;
      const quota = ServerQuotas.quotaOf(emote.animated);
      const plan = await this.allocator.plan(synced, quota, "trending");
      if (!plan.ok || plan.displace) continue; // only genuinely free slots
      const image = await this.sevenTv.downloadImage(emote.id);
      if (!image.ok) {
        new ImageFailure(emote, image.reason).recordOnce(state, report);
        continue;
      }
      const placed = await this.allocator.place(synced, report, plan, emote, image.image, "trending", emote.name);
      if (placed.suffixed) {
        const collision = NameCollision.onAdd(emote.name, placed.name, emote.id);
        if (collision.record(state)) report.say("warning", collision.text);
      }
    }
  }
}
