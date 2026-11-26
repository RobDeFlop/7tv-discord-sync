import { ServerQuotas, type DiscordEmoji, type EmojiImage, type ServerId } from "../domain/index.ts";

export abstract class DiscordPort {
  /** The Server's current boost level (0 to 3). */
  public abstract getBoostLevel(server: ServerId): Promise<number>;
  public abstract listEmojis(server: ServerId): Promise<DiscordEmoji[]>;
  public abstract createEmoji(server: ServerId, emoji: { name: string; image: EmojiImage }): Promise<DiscordEmoji>;
  public abstract renameEmoji(server: ServerId, emojiId: string, name: string): Promise<void>;
  public abstract deleteEmoji(server: ServerId, emojiId: string): Promise<void>;

  /** Slot limits at the Server's boost level; the same table for every implementation. */
  public async getQuotas(server: ServerId): Promise<ServerQuotas> {
    return new ServerQuotas(await this.getBoostLevel(server));
  }
}
