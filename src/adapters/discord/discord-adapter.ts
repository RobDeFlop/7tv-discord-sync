import { MissingPermissionError, type DiscordEmoji, type EmojiImage, type ServerId } from "../../domain/index.ts";
import { DiscordPort } from "../../ports/index.ts";
import type { GuildGateway, GuildProvider } from "./guild-gateway.ts";
import { RateLimitError, WriteQueue, type QueueProgress } from "./write-queue.ts";


export class DiscordAdapter extends DiscordPort {
  public constructor(
    private readonly guilds: GuildProvider,
    private readonly queue: WriteQueue = new WriteQueue(),
  ) {
    super();
  }

  /** Pending writes and rate-limit retry time for a Server, for /status. */
  public queueProgress(server: ServerId): QueueProgress {
    return this.queue.progress(server);
  }

  public async hasManageExpressions(server: ServerId): Promise<boolean> {
    return (await this.guilds.getGuild(server)).canManageExpressions();
  }

  public async getBoostLevel(server: ServerId): Promise<number> {
    return (await this.guilds.getGuild(server)).premiumTier;
  }

  public async listEmojis(server: ServerId): Promise<DiscordEmoji[]> {
    return (await this.guilds.getGuild(server)).listEmojis();
  }

  public createEmoji(server: ServerId, emoji: { name: string; image: EmojiImage }): Promise<DiscordEmoji> {
    return this.write(server, (g) => g.createEmoji(emoji.name, emoji.image.bytes));
  }

  public renameEmoji(server: ServerId, emojiId: string, name: string): Promise<void> {
    return this.write(server, (g) => g.renameEmoji(emojiId, name));
  }

  public deleteEmoji(server: ServerId, emojiId: string): Promise<void> {
    return this.write(server, (g) => g.deleteEmoji(emojiId));
  }

  private write<T>(server: ServerId, op: (guild: GuildGateway) => Promise<T>): Promise<T> {
    return this.queue.enqueue(server, async () => {
      const guild = await this.guilds.getGuild(server);
      if (!(await guild.canManageExpressions())) throw new MissingPermissionError(server);
      return op(guild);
    });
  }
}

export { MissingPermissionError, RateLimitError };
