import {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  RateLimitError as RestRateLimitError,
  type Guild,
} from "discord.js";
import type { DiscordEmoji, EmojiImage, ServerId } from "../../domain/index.ts";
import { Logger, LogLevel } from "../../logger.ts";
import { DiscordAdapter } from "./discord-adapter.ts";
import { GuildGateway, GuildProvider } from "./guild-gateway.ts";
import { RateLimitError, WriteQueue } from "./write-queue.ts";

/** One discord.js Guild behind the gateway; turns a 429 into RateLimitError so the write queue retries it. */
export class DiscordJsGuild extends GuildGateway {
  public constructor(
    private readonly guild: Guild,
    private readonly http: (url: string, init: RequestInit) => Promise<Response> = fetch,
  ) {
    super();
  }

  public get premiumTier(): number {
    return this.guild.premiumTier;
  }

  public async canManageExpressions(): Promise<boolean> {
    const me = await this.guild.members.fetchMe();
    return me.permissions.has(PermissionFlagsBits.ManageGuildExpressions);
  }

  public async listEmojis(): Promise<DiscordEmoji[]> {
    const all = await this.guild.emojis.fetch();
    return [...all.values()].map((e) => DiscordJsGuild.toEmoji(e));
  }

  public async downloadEmojiImage(emoji: DiscordEmoji): Promise<EmojiImage | null> {
    const { id, animated } = emoji;
    const fields = `operation=download_cdn server=${Logger.field(this.guild.id)} emoji=${Logger.field(id)}`;
    try {
      const url = this.guild.client.rest.cdn.emoji(id, { extension: animated ? "gif" : "png" });
      const response = await this.http(url, { redirect: "error" });
      if (response.ok) return { bytes: new Uint8Array(await response.arrayBuffer()), animated };
      Logger.write(LogLevel.warn, `discord_image_unavailable ${fields} status=${response.status}`);
    } catch (error) {
      Logger.write(LogLevel.warn, `discord_image_unavailable ${fields} ${Logger.failure(error)}`);
    }
    return null;
  }

  public createEmoji(name: string, image: EmojiImage): Promise<DiscordEmoji> {
    // A data URI carries the real mime type; discord.js would label a raw Buffer image/jpg.
    return DiscordJsGuild.mapRateLimit(async () =>
      DiscordJsGuild.toEmoji(await this.guild.emojis.create({ attachment: DiscordJsGuild.toDataUri(image), name })),
    );
  }

  public async renameEmoji(id: string, name: string): Promise<void> {
    await DiscordJsGuild.mapRateLimit(() => this.guild.emojis.edit(id, { name }));
  }

  public async deleteEmoji(id: string): Promise<void> {
    await DiscordJsGuild.mapRateLimit(() => this.guild.emojis.delete(id));
  }

  private static toDataUri(image: EmojiImage): string {
    const mime = image.animated ? "image/gif" : "image/png";
    return `data:${mime};base64,${Buffer.from(image.bytes).toString("base64")}`;
  }

  private static toEmoji(e: { id: string; name: string | null; animated: boolean | null }): DiscordEmoji {
    return { id: e.id, name: e.name ?? "", animated: e.animated ?? false };
  }

  private static async mapRateLimit<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof RestRateLimitError) throw new RateLimitError(DiscordJsGuild.retryDelay(error.timeToReset), { cause: error });
      if (error !== null && typeof error === "object" && "status" in error && error.status === 429) {
        const seconds = "retryAfter" in error ? error.retryAfter : undefined;
        const ms = typeof seconds === "number" ? seconds * 1000 : undefined;
        throw new RateLimitError(DiscordJsGuild.retryDelay(ms), { cause: error });
      }
      throw error;
    }
  }

  private static retryDelay(ms: number | undefined): number {
    return ms !== undefined && ms >= 0 && ms <= 2_147_483_647 ? ms : 1000;
  }
}

class DiscordJsGuildProvider extends GuildProvider {
  public constructor(private readonly client: Client) {
    super();
  }

  public async getGuild(server: ServerId): Promise<GuildGateway> {
    return new DiscordJsGuild(await this.client.guilds.fetch(server));
  }
}

/** Production adapter over a logged-in discord.js Client. */
export class DiscordJsAdapter extends DiscordAdapter {
  public constructor(client: Client, queue: WriteQueue = new WriteQueue()) {
    super(new DiscordJsGuildProvider(client), queue);
  }

  /**
   * The Client the bot needs: Guilds + GuildExpressions for emoji events, and emoji
   * route rate limits rejected (not slept on) so the write queue sees them and can report progress.
   */
  public static createClient(): Client {
    return new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildExpressions],
      rest: { rejectOnRateLimit: (info) => info.route.includes("/emojis") },
    });
  }
}
