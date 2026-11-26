import type { Quota } from "./quota.ts";
import type { ManagedTier, Tier } from "./tier.ts";
import type {
  DiscordEmojiId,
  ManagedEmoteSnapshot,
  ReservedSlotSnapshot,
  SevenTvEmoteId,
} from "./types.ts";

/** Anything occupying a Slot in a Server's emoji quota. */
export abstract class SlotOccupant {
  protected constructor(
    public readonly discordEmojiId: DiscordEmojiId,
    public readonly quota: Quota,
  ) {}

  /** Precedence, highest first: Reserved Slots, Requested Emotes, Source Set, Trending Fill. */
  private static readonly RANK: Readonly<Record<Tier, number>> = { reserved: 0, requested: 1, source: 2, trending: 3 };

  public abstract get tier(): Tier;

  /** Higher number = lower Precedence = displaced sooner. */
  public get rank(): number {
    return SlotOccupant.RANK[this.tier];
  }

  /** Displacement: only strictly lower Precedence loses its slot. Reserved Slots rank highest, so never. */
  public canBeDisplacedBy(incoming: ManagedTier): boolean {
    return this.rank > SlotOccupant.RANK[incoming];
  }
}

/** A slot held by an emoji the bot did not create. Tracked, never modified. */
export class ReservedSlot extends SlotOccupant {
  public constructor(discordEmojiId: DiscordEmojiId, quota: Quota) {
    super(discordEmojiId, quota);
  }

  public static fromSnapshot(snapshot: ReservedSlotSnapshot): ReservedSlot {
    return new ReservedSlot(snapshot.discordEmojiId, snapshot.quota);
  }

  public get tier(): Tier {
    return "reserved";
  }

  public toSnapshot(): ReservedSlotSnapshot {
    return { discordEmojiId: this.discordEmojiId, quota: this.quota };
  }
}

/** A Discord emoji created by the bot, linked to a 7TV emote. */
export class ManagedEmote extends SlotOccupant {
  private currentTier: ManagedTier;

  public constructor(
    discordEmojiId: DiscordEmojiId,
    public readonly sevenTvEmoteId: SevenTvEmoteId,
    tier: ManagedTier,
    quota: Quota,
  ) {
    super(discordEmojiId, quota);
    this.currentTier = tier;
  }

  public static fromSnapshot(snapshot: ManagedEmoteSnapshot): ManagedEmote {
    return new ManagedEmote(
      snapshot.discordEmojiId,
      snapshot.sevenTvEmoteId,
      snapshot.tier,
      snapshot.quota,
    );
  }

  public get tier(): ManagedTier {
    return this.currentTier;
  }

  /** A change of reason for holding the slot (an explicit request, joining the Source Set). */
  public promoteTo(tier: ManagedTier): void {
    this.currentTier = tier;
  }

  public toSnapshot(): ManagedEmoteSnapshot {
    return {
      discordEmojiId: this.discordEmojiId,
      sevenTvEmoteId: this.sevenTvEmoteId,
      tier: this.currentTier,
      quota: this.quota,
    };
  }
}
