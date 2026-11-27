import type { SevenTvEmote, SevenTvEmoteId } from "../domain/index.ts";
import type { SevenTvPort } from "../ports/index.ts";
import { ReconcileStep } from "./reconcile-step.ts";
import type { SlotAcquisition } from "./slot-acquisition.ts";
import type { SyncReport } from "./sync-report.ts";
import type { SyncedServer } from "./synced-server.ts";

/**
 * Mirror the linked user's active set: remove what left it (never Requested
 * Emotes), rename what was renamed, add what is new in set order.
 */
export class SourceSetMirror extends ReconcileStep {
  public constructor(private readonly sevenTv: SevenTvPort, private readonly allocator: SlotAcquisition) {
    super();
  }

  public override async run(synced: SyncedServer, report: SyncReport): Promise<void> {
    const { state } = synced;
    if (!state.linkedUserId) {
      state.problemLedger.closeSourceSet();
      return;
    }

    const user = await this.sevenTv.getUser(state.linkedUserId);
    if (!user) {
      report.say("warning", "The linked 7TV user could not be found; the Source Set was not synced.");
      return;
    }
    const set = user.activeSetId ? await this.sevenTv.getSet(user.activeSetId) : null;
    if (user.activeSetId && !set) {
      report.say("warning", "The active 7TV set could not be found; the Source Set was not synced.");
      return;
    }
    const wanted = (set?.emotes ?? []).filter((e, i, all) => all.findIndex((o) => o.id === e.id) === i);

    await this.removeDeparted(synced, report, new Set(wanted.map((e) => e.id)));
    await this.renameAndPromote(synced, report, wanted);
    await this.addMissing(synced, report, wanted);
    state.problemLedger.closeSourceSet();
  }

  /** Source Set emotes that left the set. Requested Emotes stay. */
  private async removeDeparted(synced: SyncedServer, report: SyncReport, wantedIds: Set<SevenTvEmoteId>): Promise<void> {
    for (const managed of synced.state.managedOfTier("source")) {
      if (wantedIds.has(managed.sevenTvEmoteId)) continue;
      await synced.removeManaged(managed, report, "removed");
    }
  }

  /** Renames, and promotion of Trending Fill emotes that joined the set. */
  private async renameAndPromote(synced: SyncedServer, report: SyncReport, wanted: SevenTvEmote[]): Promise<void> {
    for (const emote of wanted) {
      const managed = synced.state.findManaged(emote.id);
      if (!managed) continue;
      if (managed.tier === "trending") managed.promoteTo("source");
      if (managed.tier === "source") await this.allocator.rename(synced, report, managed, emote.name);
    }
  }

  /** Additions in set order, so the left-out emotes are deterministic. */
  private async addMissing(synced: SyncedServer, report: SyncReport, wanted: SevenTvEmote[]): Promise<void> {
    const fresh: string[] = [];
    for (const emote of wanted) {
      if (synced.state.findManaged(emote.id)) continue;
      const outcome = await this.allocator.acquire(synced, report, { emote, tier: "source" });
      if (outcome.kind === "failed") throw outcome.error;
      if (outcome.kind === "pending" && outcome.fresh) fresh.push(emote.name);
    }
    if (fresh.length > 0) report.say("warning", `No free slot for ${fresh.join(", ")}; they will be added when slots free up.`);
  }
}
