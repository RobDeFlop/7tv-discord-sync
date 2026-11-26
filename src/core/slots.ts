import {
  PRECEDENCE,
  type DiscordEmoji,
  type ManagedEmote,
  type ManagedTier,
  type Quota,
  type ServerState,
} from "../domain/index.ts";

export const quotaOf = (animated: boolean): Quota => (animated ? "animated" : "static");

/** Higher number = lower Precedence = displaced sooner. */
const rank = (tier: ManagedTier): number => PRECEDENCE.indexOf(tier);

export type SlotPlan =
  | { ok: true; displace: ManagedEmote | null }
  | { ok: false };

/**
 * Decide how an emote of `tier` gets a slot in `quota`: a free slot, or by
 * displacing the lowest-Precedence Managed Emote strictly below `tier` in the
 * same quota (ties: most recently added goes first). Reserved Slots and equal
 * or higher tiers are never displaced. Pure: the caller performs the plan.
 */
export function planSlot(
  state: ServerState,
  emojis: DiscordEmoji[],
  limit: number,
  quota: Quota,
  tier: ManagedTier,
): SlotPlan {
  const used = emojis.filter((e) => quotaOf(e.animated) === quota).length;
  if (used < limit) return { ok: true, displace: null };
  const candidates = state.managedEmotes
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => m.quota === quota && rank(m.tier) > rank(tier))
    .sort((a, b) => rank(b.m.tier) - rank(a.m.tier) || b.index - a.index);
  const victim = candidates[0]?.m;
  return victim ? { ok: true, displace: victim } : { ok: false };
}
