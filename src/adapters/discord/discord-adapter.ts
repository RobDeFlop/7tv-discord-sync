import type { DiscordEmoji, EmojiImage, ServerId, ServerQuotas } from "../../domain/index.ts";
import type { DiscordPort } from "../../ports/index.ts";
import { RateLimitError, WriteQueue, type QueueProgress } from "./write-queue.ts";

/** The bot lacks Manage Expressions on a Server. The core maps it to feedback. */
export class MissingPermissionError extends Error {
  constructor(public readonly server: ServerId) {
    super(`Missing Manage Expressions permission in server ${server}`);
  }
}

/** Discord's emoji slots per quota by boost level (0 to 3). */
const SLOTS_BY_BOOST_LEVEL = [50, 100, 150, 250] as const;

/** The slice of a discord.js Guild the adapter uses. Rate limits surface as RateLimitError. */
export interface GuildLike {
  premiumTier: number;
  canManageExpressions(): Promise<boolean>;
  listEmojis(): Promise<DiscordEmoji[]>;
  createEmoji(name: string, bytes: Uint8Array): Promise<DiscordEmoji>;
  renameEmoji(id: string, name: string): Promise<void>;
  deleteEmoji(id: string): Promise<void>;
}

export interface DiscordAdapterOptions {
  getGuild: (server: ServerId) => Promise<GuildLike>;
  queue?: WriteQueue;
}

export class DiscordAdapter implements DiscordPort {
  private getGuild: DiscordAdapterOptions["getGuild"];
  private queue: WriteQueue;

  constructor(opts: DiscordAdapterOptions) {
    this.getGuild = opts.getGuild;
    this.queue = opts.queue ?? new WriteQueue();
  }

  /** Pending writes and rate-limit retry time for a Server, for /status. */
  queueProgress(server: ServerId): QueueProgress {
    return this.queue.progress(server);
  }

  async hasManageExpressions(server: ServerId): Promise<boolean> {
    return (await this.getGuild(server)).canManageExpressions();
  }

  async getQuotas(server: ServerId): Promise<ServerQuotas> {
    const { premiumTier } = await this.getGuild(server);
    const limit = SLOTS_BY_BOOST_LEVEL[Math.min(Math.max(premiumTier, 0), 3)]!;
    return { boostLevel: premiumTier, limits: { static: limit, animated: limit } };
  }

  async listEmojis(server: ServerId): Promise<DiscordEmoji[]> {
    return (await this.getGuild(server)).listEmojis();
  }

  createEmoji(
    server: ServerId,
    emoji: { name: string; image: EmojiImage },
  ): Promise<DiscordEmoji> {
    return this.write(server, (g) => g.createEmoji(emoji.name, emoji.image.bytes));
  }

  renameEmoji(server: ServerId, emojiId: string, name: string): Promise<void> {
    return this.write(server, (g) => g.renameEmoji(emojiId, name));
  }

  deleteEmoji(server: ServerId, emojiId: string): Promise<void> {
    return this.write(server, (g) => g.deleteEmoji(emojiId));
  }

  private write<T>(server: ServerId, op: (guild: GuildLike) => Promise<T>): Promise<T> {
    return this.queue.enqueue(server, async () => {
      const guild = await this.getGuild(server);
      if (!(await guild.canManageExpressions())) throw new MissingPermissionError(server);
      return op(guild);
    });
  }
}

export { RateLimitError };
