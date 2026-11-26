// Plain data shapes of the domain (no behaviour), see GLOSSARY.md.
import type { Quota } from "./quota.ts";
import type { ManagedTier, Tier } from "./tier.ts";

/** Discord server (guild) id. All data is scoped per Server. */
export type ServerId = string;
export type SevenTvEmoteId = string;
export type SevenTvUserId = string;
export type SevenTvSetId = string;
export type DiscordEmojiId = string;

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

/** An image in Discord's emoji formats (PNG or GIF). */
export interface EmojiImage {
  bytes: Uint8Array;
  animated: boolean;
}

export interface DiscordEmoji {
  id: DiscordEmojiId;
  name: string;
  animated: boolean;
}

/** A 7TV emote an admin explicitly asked for; stays even if it leaves the Source Set. */
export interface RequestedEmote {
  sevenTvEmoteId: SevenTvEmoteId;
  /** Name the admin asked for, if any. */
  requestedName?: string;
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

export interface ManagedEmoteSnapshot {
  discordEmojiId: DiscordEmojiId;
  sevenTvEmoteId: SevenTvEmoteId;
  tier: ManagedTier;
  quota: Quota;
}

export interface ReservedSlotSnapshot {
  discordEmojiId: DiscordEmojiId;
  quota: Quota;
}

/** What the Store port persists for one Server. */
export interface ServerStateSnapshot {
  managedEmotes: ManagedEmoteSnapshot[];
  reservedSlots: ReservedSlotSnapshot[];
  requestedEmotes: RequestedEmote[];
  linkedUserId: SevenTvUserId | null;
  trending: TrendingSettings;
  logChannelId: string | null;
  problems: Problem[];
  /** Fields a newer version stored that this one does not know; kept so they survive a save. */
  extra?: Record<string, unknown>;
}

export type EmoteAddNameConflictReason = "emote-name-taken" | "emote-name-changed";

/** A message for the admin; commands reply ephemerally, automatic syncs go to the log channel. */
export interface FeedbackMessage {
  level: "info" | "warning" | "error";
  text: string;
  reason?: EmoteAddNameConflictReason | "emote-promotion-unavailable";
}

/** What a sync did to a Server's emojis. */
export type Change =
  | { type: "created"; name: string; animated: boolean; sevenTvEmoteId: SevenTvEmoteId; tier: ManagedTier }
  | { type: "renamed"; from: string; to: string }
  | { type: "deleted"; name: string; reason: "removed" | "displaced" | "unlinked" | "trending-off" | "boost-lost" }
  | { type: "reserved"; name: string };

export interface SyncResult {
  changes: Change[];
  feedback: FeedbackMessage[];
}

export interface TierUsage {
  used: number;
  free: number;
  byTier: Record<Tier, number>;
}

/** Discord writes for a Server that are still waiting, and when a rate-limited one retries. */
export interface WriteQueueProgress {
  pending: number;
  /** Epoch milliseconds, or null when not rate limited. */
  retryingAt: number | null;
}

export interface ServerStatus {
  /** False when the bot lacks Manage Expressions and so cannot change emojis. */
  manageExpressions: boolean;
  writeQueue: WriteQueueProgress;
  quotas: Record<Quota, TierUsage>;
  problems: Problem[];
  logChannelId: string | null;
  linkedUserId: SevenTvUserId | null;
  trending: TrendingSettings;
}
