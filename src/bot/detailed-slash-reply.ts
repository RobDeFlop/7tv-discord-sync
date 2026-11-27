import type { APIEmbed } from "discord.js";
import { EmbedStyle } from "./embed-style.ts";

/** Keep the same outcome-first reading order in channels that cannot show embeds. */
export class DetailedSlashReply {
  private static readonly MAX_MESSAGE = 2000;

  public constructor(private readonly embed: APIEmbed) {}

  public render(hasEmbedLinks: boolean) {
    if (hasEmbedLinks) return { embeds: [this.embed] };
    return { content: this.text(), allowedMentions: { parse: [] } };
  }

  /** The card as message text, e.g. for a channel without Embed Links. */
  public text(): string {
    const title = this.embed.title ? `**${this.embed.title}**` : undefined;
    const fields = (this.embed.fields ?? []).map(({ name, value }) => `**${name}**\n${value}`);
    const sections = [title, this.embed.url, this.embed.description, ...fields].filter(Boolean).join("\n\n");
    return EmbedStyle.clip(sections, DetailedSlashReply.MAX_MESSAGE);
  }
}
