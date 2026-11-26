import type { DiscordEmoji, ServerId } from "../../domain/index.ts";

/** The slice of one Discord guild the adapter uses. Rate limits surface as RateLimitError. */
export abstract class GuildGateway {
  public abstract get premiumTier(): number;
  public abstract canManageExpressions(): Promise<boolean>;
  public abstract listEmojis(): Promise<DiscordEmoji[]>;
  public abstract createEmoji(name: string, bytes: Uint8Array): Promise<DiscordEmoji>;
  public abstract renameEmoji(id: string, name: string): Promise<void>;
  public abstract deleteEmoji(id: string): Promise<void>;
}

/** Finds the gateway for a Server. */
export abstract class GuildProvider {
  public abstract getGuild(server: ServerId): Promise<GuildGateway>;
}
