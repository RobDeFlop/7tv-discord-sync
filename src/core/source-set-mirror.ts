import { EmoteNamer, ServerQuotas, type SevenTvEmote, type SyncResult } from "../domain/index.ts";
import { ImageFailure } from "./image-failure.ts";
import { NameCollision } from "./name-collision.ts";
import { ReconcileStep } from "./reconcile-step.ts";
import { SyncReport } from "./sync-report.ts";
import type { SyncedServer } from "./synced-server.ts";

/**
 * Mirror the linked user's active set: remove what left it (never Requested
 * Emotes), rename what was renamed, add what is new in set order, and record
 * what does not fit as pending.
 */
export class SourceSetMirror extends ReconcileStep {
  public async run(synced: SyncedServer): Promise<SyncResult> {
    const { state } = synced;
    const report = new SyncReport();
    if (!state.linkedUserId) return report.toResult();

    const user = await this.context.sevenTv.getUser(state.linkedUserId);
    if (!user) {
      report.say("warning", "The linked 7TV user could not be found; the Source Set was not synced.");
      return report.toResult();
    }
    const set = user.activeSetId ? await this.context.sevenTv.getSet(user.activeSetId) : null;
    if (user.activeSetId && !set) {
      report.say("warning", "The active 7TV set could not be found; the Source Set was not synced.");
      return report.toResult();
    }
    const hadPending = state.pendingEmoteIds();
    state.clearPending();
    const wanted = (set?.emotes ?? []).filter((e, i, all) => all.findIndex((o) => o.id === e.id) === i);

    await this.removeDeparted(synced, report, new Set(wanted.map((e) => e.id)));
    await this.renameAndPromote(synced, report, wanted);
    const pending = await this.addMissing(synced, report, wanted);
    this.recordPending(synced, report, pending, hadPending);
    return report.toResult();
  }

  /** Source Set emotes that left the set. Requested Emotes stay. */
  private async removeDeparted(synced: SyncedServer, report: SyncReport, wantedIds: Set<string>): Promise<void> {
    for (const managed of synced.state.managedOfTier("source")) {
      if (wantedIds.has(managed.sevenTvEmoteId)) continue;
      const emoji = synced.emojiOf(managed);
      await synced.deleteEmoji(emoji);
      synced.state.removeManagedEmote(managed);
      report.change({ type: "deleted", name: emoji.name, reason: "removed" });
    }
  }

  /** Renames, and promotion of Trending Fill emotes that joined the set. */
  private async renameAndPromote(synced: SyncedServer, report: SyncReport, wanted: SevenTvEmote[]): Promise<void> {
    for (const emote of wanted) {
      const managed = synced.state.findManaged(emote.id);
      if (!managed) continue;
      if (managed.tier === "trending") managed.promoteTo("source");
      if (managed.tier !== "source") continue;
      const emoji = synced.emojiOf(managed);
      const { name, suffixed } = EmoteNamer.unique(emote.name, synced.emojiNamesExcept(emoji.id));
      if (name === emoji.name) continue;
      await synced.renameEmoji(emoji, name);
      report.change({ type: "renamed", from: emoji.name, to: name });
      if (suffixed) {
        const collision = NameCollision.onRename(emote.name, name, emote.id);
        if (collision.record(synced.state)) report.say("warning", collision.text);
      } else {
        synced.state.clearProblem({ kind: "renamed-with-suffix", sevenTvEmoteId: emote.id });
      }
    }
  }

  /** Additions in set order, so the left-out emotes are deterministic. Returns what did not fit. */
  private async addMissing(synced: SyncedServer, report: SyncReport, wanted: SevenTvEmote[]): Promise<SevenTvEmote[]> {
    const { state } = synced;
    const pending: SevenTvEmote[] = [];
    for (const emote of wanted) {
      if (state.findManaged(emote.id)) continue;
      const quota = ServerQuotas.quotaOf(emote.animated);
      const plan = await this.context.allocator.plan(synced, quota, "source");
      if (!plan.ok) {
        pending.push(emote);
        continue;
      }
      const image = await this.context.sevenTv.downloadImage(emote.id);
      if (!image.ok) {
        new ImageFailure(emote, image.reason).recordOnce(state, report);
        continue;
      }
      const placed = await this.context.allocator.place(synced, report, plan, emote, image.image, "source", emote.name);
      if (placed.suffixed) {
        const collision = NameCollision.onAdd(emote.name, placed.name, emote.id);
        if (collision.record(state)) report.say("warning", collision.text);
      }
    }
    return pending;
  }

  private recordPending(
    synced: SyncedServer,
    report: SyncReport,
    pending: SevenTvEmote[],
    hadPending: Set<string | undefined>,
  ): void {
    for (const emote of pending) {
      synced.state.addProblem({
        kind: "pending",
        message: `${emote.name} is waiting for a free ${ServerQuotas.quotaOf(emote.animated)} slot.`,
        sevenTvEmoteId: emote.id,
      });
    }
    const fresh = pending.filter((e) => !hadPending.has(e.id));
    if (fresh.length > 0) {
      report.say(
        "warning",
        `No free slot for ${fresh.map((e) => e.name).join(", ")}; they will be added when slots free up.`,
      );
    }
  }
}
