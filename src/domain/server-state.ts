import { ProblemLedger } from "./problem-ledger.ts";
import { ServerQuotas, type Quota } from "./quota.ts";
import { ManagedEmote, ReservedSlot } from "./slot-occupant.ts";
import type { ManagedTier } from "./tier.ts";
import type {
  DiscordEmoji,
  DiscordEmojiId,
  Problem,
  RequestedEmote,
  ServerStateSnapshot,
  SevenTvEmoteId,
  SevenTvUserId,
  TrendingPeriod,
  TrendingSettings,
} from "./types.ts";

export type SlotPlan = { ok: true; displace: ManagedEmote | null } | { ok: false };

/** Everything the bot persists for one Server. */
export class ServerState {
  private managed: ManagedEmote[];
  private reserved: ReservedSlot[];
  private requested: RequestedEmote[];
  private linkedUser: SevenTvUserId | null;
  private trendingSettings: TrendingSettings;
  private logChannel: string | null;
  public readonly problemLedger: ProblemLedger;
  private readonly extra: Record<string, unknown>;

  private constructor(snapshot: ServerStateSnapshot) {
    this.managed = snapshot.managedEmotes.map((m) => ManagedEmote.fromSnapshot(m));
    this.reserved = snapshot.reservedSlots.map((r) => ReservedSlot.fromSnapshot(r));
    this.requested = snapshot.requestedEmotes.map((r) => ({ ...r }));
    this.linkedUser = snapshot.linkedUserId;
    this.trendingSettings = { ...snapshot.trending };
    this.logChannel = snapshot.logChannelId;
    this.problemLedger = new ProblemLedger(snapshot.problems);
    this.extra = { ...snapshot.extra };
  }

  public static empty(): ServerState {
    return new ServerState({
      managedEmotes: [],
      reservedSlots: [],
      requestedEmotes: [],
      linkedUserId: null,
      trending: { enabled: false, period: "week" },
      logChannelId: null,
      problems: [],
    });
  }

  public static fromSnapshot(snapshot: ServerStateSnapshot): ServerState {
    return new ServerState(snapshot);
  }

  /** A deep copy as plain data; mutating it never touches this state. */
  public toSnapshot(): ServerStateSnapshot {
    const snapshot: ServerStateSnapshot = {
      managedEmotes: this.managed.map((m) => m.toSnapshot()),
      reservedSlots: this.reserved.map((r) => r.toSnapshot()),
      requestedEmotes: this.requested.map((r) => ({ ...r })),
      linkedUserId: this.linkedUser,
      trending: { ...this.trendingSettings },
      logChannelId: this.logChannel,
      problems: this.problemLedger.snapshot(),
    };
    if (Object.keys(this.extra).length > 0) snapshot.extra = structuredClone(this.extra);
    return snapshot;
  }

  public get managedEmotes(): ReadonlyArray<ManagedEmote> {
    return this.managed;
  }

  public get reservedSlots(): ReadonlyArray<ReservedSlot> {
    return this.reserved;
  }

  public get requestedEmotes(): ReadonlyArray<RequestedEmote> {
    return this.requested;
  }

  public get problems(): ReadonlyArray<Problem> {
    return this.problemLedger.snapshot();
  }

  public get linkedUserId(): SevenTvUserId | null {
    return this.linkedUser;
  }

  public get trending(): Readonly<TrendingSettings> {
    return this.trendingSettings;
  }

  public get logChannelId(): string | null {
    return this.logChannel;
  }

  public findManaged(sevenTvEmoteId: SevenTvEmoteId): ManagedEmote | undefined {
    return this.managed.find((m) => m.sevenTvEmoteId === sevenTvEmoteId);
  }

  public findManagedByEmoji(discordEmojiId: DiscordEmojiId): ManagedEmote | undefined {
    return this.managed.find((m) => m.discordEmojiId === discordEmojiId);
  }

  public managedOfTier(tier: ManagedTier): ManagedEmote[] {
    return this.managed.filter((m) => m.tier === tier);
  }

  public addManagedEmote(emote: ManagedEmote): void {
    this.managed.push(emote);
  }

  public removeManagedEmote(emote: ManagedEmote): void {
    this.managed = this.managed.filter((m) => m !== emote);
    if (emote.tier === "requested") this.requested = this.requested.filter((r) => r.sevenTvEmoteId !== emote.sevenTvEmoteId);
  }

  /**
   * Unlink the 7TV user and stop managing the Source Set's emotes. With `keepAsReserved` their
   * emojis stay and become Reserved Slots; otherwise the caller deletes the emojis. Returns the
   * emotes that were released.
   */
  public unlinkSource(keepAsReserved: boolean): ManagedEmote[] {
    const released = this.managedOfTier("source");
    this.managed = this.managed.filter((m) => m.tier !== "source");
    if (keepAsReserved) this.reserved.push(...released.map((m) => new ReservedSlot(m.discordEmojiId, m.quota)));
    this.linkedUser = null;
    this.problemLedger.sourceUnlinked();
    return released;
  }

  public addRequestedEmote(request: RequestedEmote): void {
    this.requested.push(request);
  }

  public linkUser(userId: SevenTvUserId): void {
    this.linkedUser = userId;
  }

  /** Turn Trending Fill on or off; without a period the current one is kept. */
  public setTrending(enabled: boolean, period?: TrendingPeriod): void {
    this.trendingSettings = { enabled, period: period ?? this.trendingSettings.period };
  }

  public setLogChannel(channelId: string): void {
    this.logChannel = channelId;
  }

  /**
   * Register every emoji the bot did not create as a Reserved Slot, and forget
   * Managed Emotes that were deleted by hand (freeing their slot).
   */
  public syncOwnership(emojis: ReadonlyArray<DiscordEmoji>): void {
    const present = new Set(emojis.map((e) => e.id));
    this.managed = this.managed.filter((m) => present.has(m.discordEmojiId));
    const managedIds = new Set(this.managed.map((m) => m.discordEmojiId));
    this.reserved = emojis
      .filter((e) => !managedIds.has(e.id))
      .map((e) => new ReservedSlot(e.id, ServerQuotas.quotaOf(e.animated)));
  }

  /**
   * The `count` Managed Emotes of `quota` to give up first when it shrinks:
   * lowest Precedence first, most recently added first within a tier. Reserved
   * Slots are never listed, so fewer than `count` may come back.
   */
  public lowestPrecedence(quota: Quota, count: number): ManagedEmote[] {
    return this.managed
      .map((m, index) => ({ m, index }))
      .filter(({ m }) => m.quota === quota)
      .sort((a, b) => b.m.rank - a.m.rank || b.index - a.index)
      .slice(0, Math.max(0, count))
      .map(({ m }) => m);
  }

  /**
   * Decide how an emote of `tier` gets a slot in `quota`: a free slot, or by
   * displacing the lowest-Precedence Managed Emote strictly below `tier` in the
   * same quota (ties: most recently added goes first). Reserved Slots and equal
   * or higher tiers are never displaced. Pure: the caller performs the plan.
   */
  public planSlot(quota: Quota, tier: ManagedTier, used: number, limit: number): SlotPlan {
    if (used < limit) return { ok: true, displace: null };
    // One Displacement cannot free a Slot while the Server is already over quota.
    if (used > limit) return { ok: false };
    const victim = this.managed
      .map((m, index) => ({ m, index }))
      .filter(({ m }) => m.quota === quota && m.canBeDisplacedBy(tier))
      .sort((a, b) => b.m.rank - a.m.rank || b.index - a.index)[0]?.m;
    return victim ? { ok: true, displace: victim } : { ok: false };
  }
}
