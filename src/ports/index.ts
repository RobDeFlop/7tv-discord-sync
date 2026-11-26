import type {
  DiscordEmoji,
  EmojiImage,
  ServerId,
  ServerQuotas,
  ServerState,
  SevenTvEmote,
  SevenTvEmoteId,
  SevenTvEmoteSet,
  SevenTvSetId,
  SevenTvUser,
  SevenTvUserId,
  TrendingPeriod,
} from "../domain/index.ts";

/** Thrown by ports when a link cannot be resolved. The core maps it to feedback. */
export class InvalidLinkError extends Error {
  constructor(public readonly link: string) {
    super(`Not a valid 7TV link: ${link}`);
  }
}

export type ImageResult =
  | { ok: true; image: EmojiImage }
  | { ok: false; reason: "too-large" | "unavailable" };

export type SevenTvChange =
  | { type: "set-changed"; setId: SevenTvSetId }
  | { type: "active-set-switched"; userId: SevenTvUserId };

export interface SevenTvPort {
  /** Throws InvalidLinkError. */
  resolveEmoteLink(link: string): Promise<SevenTvEmote>;
  /** Throws InvalidLinkError. */
  resolveUserLink(link: string): Promise<SevenTvUser>;
  getUser(id: SevenTvUserId): Promise<SevenTvUser | null>;
  getSet(id: SevenTvSetId): Promise<SevenTvEmoteSet | null>;
  getTrending(period: TrendingPeriod, limit: number): Promise<SevenTvEmote[]>;
  /**
   * Download the emote ready for Discord. The adapter runs the image pipeline,
   * so a result is either under the size limit or a failure.
   */
  downloadImage(id: SevenTvEmoteId): Promise<ImageResult>;
  /** Returns an unsubscribe function. */
  subscribe(listener: (change: SevenTvChange) => void): () => void;
}

export interface DiscordPort {
  getQuotas(server: ServerId): Promise<ServerQuotas>;
  listEmojis(server: ServerId): Promise<DiscordEmoji[]>;
  createEmoji(server: ServerId, emoji: { name: string; image: EmojiImage }): Promise<DiscordEmoji>;
  renameEmoji(server: ServerId, emojiId: string, name: string): Promise<void>;
  deleteEmoji(server: ServerId, emojiId: string): Promise<void>;
}

export interface StorePort {
  /** Returns an empty state for an unknown Server. */
  load(server: ServerId): Promise<ServerState>;
  save(server: ServerId, state: ServerState): Promise<void>;
  /** For catch-up and the scheduler: every Server with stored state. */
  listServers(): Promise<ServerId[]>;
  remove(server: ServerId): Promise<void>;
}
