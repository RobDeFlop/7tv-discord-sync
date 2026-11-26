/** Precedence order, highest first: Reserved Slots, Requested Emotes, Source Set, Trending Fill. */
export const PRECEDENCE = ["reserved", "requested", "source", "trending"] as const;
export type Tier = (typeof PRECEDENCE)[number];

/** Managed Emotes can only hold the tiers the bot grants itself. */
export type ManagedTier = Exclude<Tier, "reserved">;

export class Precedence {
  /** Lower number = higher Precedence. */
  public static rankOf(tier: Tier): number {
    return PRECEDENCE.indexOf(tier);
  }
}
