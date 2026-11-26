import { PermissionFlagsBits, type Client, type Guild } from "discord.js";
import type { DiscordEmoji, ServerId } from "../../domain/index.ts";
import { DiscordAdapter } from "./discord-adapter.ts";
import { GuildGateway, GuildProvider } from "./guild-gateway.ts";
import { RateLimitError, WriteQueue } from "./write-queue.ts";

/** One discord.js Guild behind the gateway; turns a 429 into RateLimitError so the write queue retries it. */
export class DiscordJsGuild extends GuildGateway {
  public constructor(private readonly guild: Guild) {
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

  public createEmoji(name: string, bytes: Uint8Array): Promise<DiscordEmoji> {
    return DiscordJsGuild.mapRateLimit(async () =>
      DiscordJsGuild.toEmoji(await this.guild.emojis.create({ attachment: Buffer.from(bytes), name })),
    );
  }

  public async renameEmoji(id: string, name: string): Promise<void> {
    await DiscordJsGuild.mapRateLimit(() => this.guild.emojis.edit(id, { name }));
  }

  public async deleteEmoji(id: string): Promise<void> {
    await DiscordJsGuild.mapRateLimit(() => this.guild.emojis.delete(id));
  }

  private static toEmoji(e: { id: string; name: string | null; animated: boolean | null }): DiscordEmoji {
    return { id: e.id, name: e.name ?? "", animated: e.animated ?? false };
  }

  private static async mapRateLimit<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (e) {
      const err = e as { status?: number; retryAfter?: number; timeToReset?: number };
      if (err?.status === 429 || err?.timeToReset !== undefined) {
        throw new RateLimitError(err.timeToReset ?? (err.retryAfter ?? 1) * 1000);
      }
      throw e;
    }
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
}
