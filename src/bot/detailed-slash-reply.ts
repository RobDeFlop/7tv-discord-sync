import type { APIEmbed } from "discord.js";

/** Keep the same outcome-first reading order in channels that cannot show embeds. */
export class DetailedSlashReply {
  public static render(embed: APIEmbed, hasEmbedLinks: boolean) {
    if (hasEmbedLinks) return { embeds: [embed] };
    const fields = (embed.fields ?? []).map(({ name, value }) => `**${name}**\n${value}`);
    const sections = [embed.title, embed.description, ...fields];
    return { content: sections.filter(Boolean).join("\n\n").slice(0, 2000), allowedMentions: { parse: [] } };
  }
}
