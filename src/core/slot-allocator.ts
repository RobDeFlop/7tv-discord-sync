import {
  DisplacementError,
  EmoteNamer,
  ManagedEmote,
  ServerQuotas,
  type DiscordEmoji,
  type EmojiImage,
  type ManagedTier,
  type Quota,
  type SevenTvEmote,
  type SlotPlan,
} from "../domain/index.ts";
import type { SyncReport } from "./sync-report.ts";
import type { SyncedServer } from "./synced-server.ts";

export interface Placement {
  name: string;
  /** The wanted name was taken, so a suffix was added. */
  suffixed: boolean;
}

/** Gives emotes their slots: plans by Precedence, displaces, creates the emoji. */
export class SlotAllocator {
  public async plan(synced: SyncedServer, quota: Quota, tier: ManagedTier): Promise<SlotPlan> {
    const quotas = await synced.quotas();
    return synced.state.planSlot(quota, tier, synced.usedIn(quota), quotas.limit());
  }

  /**
   * Perform a successful plan: delete the displaced Managed Emote if any, create
   * the emoji under a free name and register it as a Managed Emote of `tier`.
   */
  public async place(
    synced: SyncedServer,
    report: SyncReport,
    plan: Extract<SlotPlan, { ok: true }>,
    emote: SevenTvEmote,
    image: EmojiImage,
    tier: ManagedTier,
    wantedName: string,
  ): Promise<Placement> {
    const { state } = synced;
    let victim: DiscordEmoji | undefined;
    if (plan.displace) {
      victim = await synced.removeManaged(plan.displace, report, "displaced");
      report.say("warning", `${victim.name} (${plan.displace.tier}) was removed to make room for ${emote.name}.`);
    }
    const { name, suffixed } = EmoteNamer.unique(wantedName, synced.emojiNames());
    let created: DiscordEmoji;
    try {
      created = await synced.createEmoji(name, image);
    } catch (cause) {
      if (!victim || !plan.displace) throw cause;
      const error = new DisplacementError(name, victim.name, cause);
      state.recordProblem({ kind: "pending", sevenTvEmoteId: plan.displace.sevenTvEmoteId, message: error.message });
      throw error;
    }
    state.addManagedEmote(new ManagedEmote(created.id, emote.id, tier, ServerQuotas.quotaOf(emote.animated)));
    report.change({ type: "created", name, animated: emote.animated, sevenTvEmoteId: emote.id, tier });
    return { name, suffixed };
  }
}
