// Domain vocabulary, see GLOSSARY.md. Pure types, no dependencies.

/** Discord server (guild) id. All data is scoped per Server. */
export type ServerId = string;
export type SevenTvEmoteId = string;
export type SevenTvUserId = string;
export type SevenTvSetId = string;
export type DiscordEmojiId = string;

/** Static and animated emojis have separate quotas. */
export type Quota = "static" | "animated";

/** Precedence order, highest first: Reserved Slots, Requested Emotes, Source Set, Trending Fill. */
export const PRECEDENCE = ["reserved", "requested", "source", "trending"] as const;
export type Tier = (typeof PRECEDENCE)[number];

/** Managed Emotes can only hold the tiers the bot grants itself. */
export type ManagedTier = Exclude<Tier, "reserved">;

export type TrendingPeriod = "day" | "week" | "month" | "all-time";

export interface SevenTvEmote {
  id: SevenTvEmoteId;
  name: string;
  animated: boolean;
}

export interface SevenTvUser {
  id: SevenTvUserId;
  username: string;
  /** Currently active emote set; the Source Set follows this. */
  activeSetId: SevenTvSetId | null;
}

export interface SevenTvEmoteSet {
  id: SevenTvSetId;
  name: string;
  emotes: SevenTvEmote[];
}

/** An image already converted and shrunk to what Discord accepts. */
export interface EmojiImage {
  bytes: Uint8Array;
  animated: boolean;
}

export interface DiscordEmoji {
  id: DiscordEmojiId;
  name: string;
  animated: boolean;
}

export interface ServerQuotas {
  boostLevel: number;
  /** Max emojis per quota at the current boost level. */
  limits: Record<Quota, number>;
}

/** A Discord emoji created by the bot, linked to a 7TV emote. */
export interface ManagedEmote {
  discordEmojiId: DiscordEmojiId;
  sevenTvEmoteId: SevenTvEmoteId;
  tier: ManagedTier;
  quota: Quota;
}

/** A 7TV emote an admin explicitly asked for; stays even if it leaves the Source Set. */
export interface RequestedEmote {
  sevenTvEmoteId: SevenTvEmoteId;
  /** Name the admin asked for, if any. */
  requestedName?: string;
}

/** An emoji the bot did not create. Tracked, never modified. */
export interface ReservedSlot {
  discordEmojiId: DiscordEmojiId;
  quota: Quota;
}

export type ProblemKind = "skipped" | "too-large" | "renamed-with-suffix" | "pending";

export interface Problem {
  kind: ProblemKind;
  message: string;
  sevenTvEmoteId?: SevenTvEmoteId;
}

export interface TrendingSettings {
  enabled: boolean;
  period: TrendingPeriod;
}

/** Everything the bot persists for one Server. */
export interface ServerState {
  managedEmotes: ManagedEmote[];
  reservedSlots: ReservedSlot[];
  requestedEmotes: RequestedEmote[];
  linkedUserId: SevenTvUserId | null;
  trending: TrendingSettings;
  logChannelId: string | null;
  problems: Problem[];
}

export function emptyServerState(): ServerState {
  return {
    managedEmotes: [],
    reservedSlots: [],
    requestedEmotes: [],
    linkedUserId: null,
    trending: { enabled: false, period: "week" },
    logChannelId: null,
    problems: [],
  };
}

/** A message for the admin; commands reply ephemerally, automatic syncs go to the log channel. */
export interface FeedbackMessage {
  level: "info" | "warning" | "error";
  text: string;
}

/** What a sync did to a Server's emojis. */
export type Change =
  | { type: "created"; name: string; animated: boolean; sevenTvEmoteId: SevenTvEmoteId; tier: ManagedTier }
  | { type: "renamed"; from: string; to: string }
  | { type: "deleted"; name: string; reason: "removed" | "displaced" | "unlinked" | "trending-off" }
  | { type: "reserved"; name: string };

export type Command =
  | { type: "add"; link: string; name?: string }
  | { type: "remove"; name: string }
  | { type: "link"; link: string }
  | { type: "unlink"; keepEmotes: boolean }
  | { type: "set-trending"; enabled: boolean; period?: TrendingPeriod }
  | { type: "config"; logChannelId: string };

export interface SyncResult {
  changes: Change[];
  feedback: FeedbackMessage[];
}

export interface TierUsage {
  used: number;
  free: number;
  byTier: Record<Tier, number>;
}

export interface ServerStatus {
  quotas: Record<Quota, TierUsage>;
  problems: Problem[];
  logChannelId: string | null;
  linkedUserId: SevenTvUserId | null;
  trending: TrendingSettings;
}
