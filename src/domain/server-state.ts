import { ServerQuotas, type Quota } from "./quota.ts";
import { ManagedEmote, ReservedSlot } from "./slot-occupant.ts";
import type { ManagedTier } from "./tier.ts";
import type {
  DiscordEmoji,
  DiscordEmojiId,
  Problem,
  ProblemKind,
  RequestedEmote,
  ServerStateSnapshot,
  SevenTvEmoteId,
  SevenTvUserId,
  TrendingPeriod,
  TrendingSettings,
} from "./types.ts";

export type SlotPlan = { ok: true; displace: ManagedEmote | null } | { ok: false };

/** Selects recorded problems; an omitted field matches anything. */
export interface ProblemMatch {
  kind: ProblemKind;
  sevenTvEmoteId?: SevenTvEmoteId;
  message?: string;
}

/** Everything the bot persists for one Server. */
export class ServerState {
  private managed: ManagedEmote[];
  private reserved: ReservedSlot[];
  private requested: RequestedEmote[];
  private linkedUser: SevenTvUserId | null;
  private trendingSettings: TrendingSettings;
  private logChannel: string | null;
  private problemList: Problem[];
  private readonly extra: Record<string, unknown>;
  /** Problems found again during the current review (see beginProblemReview). */
  private readonly confirmed = new Set<Problem>();

  private constructor(snapshot: ServerStateSnapshot) {
    this.managed = snapshot.managedEmotes.map((m) => ManagedEmote.fromSnapshot(m));
    this.reserved = snapshot.reservedSlots.map((r) => ReservedSlot.fromSnapshot(r));
    this.requested = snapshot.requestedEmotes.map((r) => ({ ...r }));
    this.linkedUser = snapshot.linkedUserId;
    this.trendingSettings = { ...snapshot.trending };
    this.logChannel = snapshot.logChannelId;
    this.problemList = snapshot.problems.map((p) => ({ ...p }));
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
      problems: this.problemList.map((p) => ({ ...p })),
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
    return this.problemList;
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
  }

  /** Kept Managed Emotes simply stop being managed; ownership sync turns them into Reserved Slots. */
  public releaseManagedOfTier(tier: ManagedTier): void {
    this.managed = this.managed.filter((m) => m.tier !== tier);
  }

  public addRequestedEmote(request: RequestedEmote): void {
    this.requested.push(request);
  }

  public removeRequestedEmote(sevenTvEmoteId: SevenTvEmoteId): void {
    this.requested = this.requested.filter((r) => r.sevenTvEmoteId !== sevenTvEmoteId);
  }

  public linkUser(userId: SevenTvUserId): void {
    this.linkedUser = userId;
  }

  public unlinkUser(): void {
    this.linkedUser = null;
  }

  /** Turn Trending Fill on or off; without a period the current one is kept. */
  public setTrending(enabled: boolean, period?: TrendingPeriod): void {
    this.trendingSettings = { enabled, period: period ?? this.trendingSettings.period };
  }

  public setLogChannel(channelId: string): void {
    this.logChannel = channelId;
  }

  /** Record a problem unless an identical one is already recorded; either way it counts as confirmed in this review. */
  public recordProblem(problem: Problem): void {
    const existing = this.problemList.find((p) => ServerState.matches(p, problem));
    if (existing) {
      this.confirmed.add(existing);
    } else {
      this.problemList.push(problem);
      this.confirmed.add(problem);
    }
  }

  /** Record a problem even if an identical one exists (used for the rebuilt pending list). */
  public addProblem(problem: Problem): void {
    this.problemList.push(problem);
  }

  /** Whether a problem of `kind` is recorded for the emote (or, with `message`, with that text). */
  public hasProblem(match: ProblemMatch): boolean {
    return this.problemList.some((p) => ServerState.matches(p, match));
  }

  /** Mark matching problems as still current in this review. */
  public confirmProblem(match: ProblemMatch): void {
    for (const p of this.problemList) if (ServerState.matches(p, match)) this.confirmed.add(p);
  }

  /** Forget matching problems. */
  public clearProblem(match: ProblemMatch): void {
    this.problemList = this.problemList.filter((p) => !ServerState.matches(p, match));
  }

  /** Start a review: problems must be confirmed again to survive {@link endProblemReview}. */
  public beginProblemReview(): void {
    this.confirmed.clear();
  }

  /**
   * End a review and drop what is no longer current: skipped and too-large problems nothing
   * confirmed again, and suffix notices for emotes that are not managed any more. Pending
   * problems are rebuilt by the Source Set mirror itself.
   */
  public endProblemReview(): void {
    this.problemList = this.problemList.filter((p) => this.isCurrent(p));
    this.confirmed.clear();
  }

  private isCurrent(problem: Problem): boolean {
    switch (problem.kind) {
      case "pending":
        return true;
      case "renamed-with-suffix":
        return problem.sevenTvEmoteId !== undefined && this.findManaged(problem.sevenTvEmoteId) !== undefined;
      default:
        return this.confirmed.has(problem);
    }
  }

  private static matches(problem: Problem, match: ProblemMatch): boolean {
    return (
      problem.kind === match.kind &&
      (match.sevenTvEmoteId === undefined || problem.sevenTvEmoteId === match.sevenTvEmoteId) &&
      (match.message === undefined || problem.message === match.message)
    );
  }

  public pendingEmoteIds(): Set<SevenTvEmoteId | undefined> {
    return new Set(this.problemList.filter((p) => p.kind === "pending").map((p) => p.sevenTvEmoteId));
  }

  public clearPending(): void {
    this.problemList = this.problemList.filter((p) => p.kind !== "pending");
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
    const victim = this.managed
      .map((m, index) => ({ m, index }))
      .filter(({ m }) => m.quota === quota && m.canBeDisplacedBy(tier))
      .sort((a, b) => b.m.rank - a.m.rank || b.index - a.index)[0]?.m;
    return victim ? { ok: true, displace: victim } : { ok: false };
  }
}
