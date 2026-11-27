import type { APIEmbed } from "discord.js";

/** Keep the same outcome-first reading order in channels that cannot show embeds. */
export class DetailedSlashReply {
  public constructor(private readonly embed: APIEmbed) {}

  public render(hasEmbedLinks: boolean) {
    if (hasEmbedLinks) return { embeds: [this.embed] };
    const fields = (this.embed.fields ?? []).map(({ name, value }) => `**${name}**\n${value}`);
    const sections = [this.embed.title, this.embed.description, ...fields];
    return { content: sections.filter(Boolean).join("\n\n").slice(0, 2000), allowedMentions: { parse: [] } };
  }
}
