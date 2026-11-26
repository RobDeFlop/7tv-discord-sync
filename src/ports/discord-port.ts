import { ServerQuotas, type DiscordEmoji, type EmojiImage, type ServerId, type WriteQueueProgress } from "../domain/index.ts";

/** A write hit Discord's rate limit; the queue waits and retries. */
export class RateLimitError extends Error {
  public constructor(public readonly retryAfterMs: number) {
    super(`Rate limited, retry after ${retryAfterMs}ms`);
  }
}

export abstract class DiscordPort {
  /** The Server's current boost level (0 to 3). */
  public abstract getBoostLevel(server: ServerId): Promise<number>;
  /** Whether the bot holds Manage Expressions on the Server, i.e. may add, rename and remove emojis. */
  public abstract hasManageExpressions(server: ServerId): Promise<boolean>;
  public abstract listEmojis(server: ServerId): Promise<DiscordEmoji[]>;
  public abstract createEmoji(server: ServerId, emoji: { name: string; image: EmojiImage }): Promise<DiscordEmoji>;
  public abstract renameEmoji(server: ServerId, emojiId: string, name: string): Promise<void>;
  public abstract deleteEmoji(server: ServerId, emojiId: string): Promise<void>;

  /** Writes still waiting for a Server; implementations with a write queue override this. */
  public queueProgress(_server: ServerId): WriteQueueProgress {
    return { pending: 0, retryingAt: null };
  }

  /** Slot limits at the Server's boost level; the same table for every implementation. */
  public async getQuotas(server: ServerId): Promise<ServerQuotas> {
    return new ServerQuotas(await this.getBoostLevel(server));
  }
}
