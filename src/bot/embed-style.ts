import type { APIEmbed, APIEmbedField } from "discord.js";
import type { FeedbackMessage } from "../domain/index.ts";

/** How an embed reads at a glance; it picks the side colour and the default title icon. */
export type EmbedTone = "success" | "warning" | "error" | "info" | "neutral";

export interface EmbedCard {
  tone: EmbedTone;
  title: string;
  /** Replaces the tone's default icon; an empty string shows none. */
  icon?: string;
  description?: string;
  fields?: ReadonlyArray<APIEmbedField>;
  url?: string;
  image?: APIEmbed["image"];
}

/** The visual language every bot embed shares, so private replies and log posts read as one product. */
export class EmbedStyle {
  public static readonly MAX_TOTAL = 6000;
  public static readonly MAX_DESCRIPTION = 4096;
  public static readonly MAX_FIELD_VALUE = 1024;
  private static readonly MAX_TITLE = 256;
  private static readonly FOOTER = "7TV Discord Sync";
  private static readonly BAR_WIDTH = 10;
  private static readonly COLORS: Record<EmbedTone, number> = {
    success: 0x3ba55d,
    warning: 0xf0b232,
    error: 0xed4245,
    info: 0x29b6f6,
    neutral: 0x80848e,
  };
  private static readonly ICONS: Record<EmbedTone, string> = {
    success: "✅", warning: "⚠️", error: "❌", info: "ℹ️", neutral: "",
  };
  private static readonly LEVEL_ICONS: Record<FeedbackMessage["level"], string> = { info: "", warning: "⚠️", error: "❌" };

  public static card({ tone, title, icon, description, fields, url, image }: EmbedCard): APIEmbed {
    const prefix = icon ?? EmbedStyle.ICONS[tone];
    return {
      color: EmbedStyle.COLORS[tone],
      title: EmbedStyle.clip(prefix ? `${prefix} ${title}` : title, EmbedStyle.MAX_TITLE),
      ...(url ? { url } : {}),
      ...(description ? { description } : {}),
      ...(fields?.length ? { fields: [...fields] } : {}),
      ...(image ? { image } : {}),
      footer: { text: EmbedStyle.FOOTER },
    };
  }

  /** Characters a card spends outside its description, for fitting the description into Discord's total limit. */
  public static overhead(title: string, fields: ReadonlyArray<APIEmbedField>): number {
    const fieldText = fields.reduce((total, { name, value }) => total + name.length + value.length, 0);
    // The margin covers the icon a card adds to its title.
    return title.length + 8 + fieldText + EmbedStyle.FOOTER.length;
  }

  /** The most severe level present decides the tone; info alone reads as success. */
  public static tone(feedback: ReadonlyArray<FeedbackMessage>): EmbedTone {
    if (feedback.some(({ level }) => level === "error")) return "error";
    if (feedback.some(({ level }) => level === "warning")) return "warning";
    return "success";
  }

  public static line({ level, text }: FeedbackMessage): string {
    const icon = EmbedStyle.LEVEL_ICONS[level];
    return icon ? `${icon} ${text}` : text;
  }

  /** Join whole lines within `max`, cutting an oversized first line and counting what was left out. */
  public static lines(lines: ReadonlyArray<string>, max: number, separator = "\n"): string {
    const whole = lines.join(separator);
    if (whole.length <= max) return whole;
    let text = "";
    for (const [index, line] of lines.entries()) {
      const left = lines.length - index - 1;
      const more = left > 0 ? `${separator}…and ${left} more` : "";
      const next = text ? `${text}${separator}${line}` : line;
      if (next.length + more.length <= max) {
        text = next;
        continue;
      }
      // The previous line was kept only if this same count still fit after it.
      if (text) return `${text}${separator}…and ${lines.length - index} more`;
      return EmbedStyle.clip(line, max - more.length) + more;
    }
    return text;
  }

  public static clip(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).toWellFormed()}…`;
  }

  /** A fixed-width usage meter, e.g. `▰▰▰▱▱▱▱▱▱▱`. */
  public static bar(used: number, total: number): string {
    const width = EmbedStyle.BAR_WIDTH;
    // Any use fills at least one segment, so a nearly empty quota never reads as unused.
    const filled = used > 0 && total > 0 ? Math.min(width, Math.max(1, Math.round((used / total) * width))) : 0;
    return `${"▰".repeat(filled)}${"▱".repeat(width - filled)}`;
  }

  public static relativeTime(epochMs: number): string {
    return `<t:${Math.floor(epochMs / 1000)}:R>`;
  }
}
