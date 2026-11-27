import type { APIEmbed } from "discord.js";
import type { ServerId } from "../domain/index.ts";
import type { EmoteAddPreview } from "./emote-add-interaction.ts";

export type SlashReply = APIEmbed | EmoteAddPreview;

/** One invocation of a slash command, as far as the bot's command handlers need to see it. */
export abstract class SlashRequest {
  /** Full command path, e.g. "emote add" or "sync". */
  public abstract get commandPath(): string;
  /** The Server it was used in, or null in a direct message. */
  public abstract get serverId(): ServerId | null;
  public abstract get isAdministrator(): boolean;
  public abstract get userId(): string;
  /** Epoch milliseconds at creation, not at the point work was queued. */
  public abstract get createdAt(): number;

  /** Untrusted option value; undefined if not provided. */
  public abstract option(name: string): unknown;

  public stringOption(name: string): string | null {
    const value = this.option(name);
    return typeof value === "string" ? value : null;
  }

  /** Acknowledge now; the command will supply its reply later. Replies are always ephemeral. */
  public abstract defer(): Promise<void>;
  public abstract reply(reply: SlashReply): Promise<void>;
  /** Edit the original ephemeral acknowledgement, never send a follow-up. */
  public abstract editOriginal(embed: APIEmbed): Promise<void>;
}
