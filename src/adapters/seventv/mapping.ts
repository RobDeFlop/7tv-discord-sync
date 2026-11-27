import type { SevenTvEmote, SevenTvEmoteSet, SevenTvUser } from "../../domain/index.ts";

// Shapes of the 7TV v3 responses we read (only the fields we use).
export interface ApiFile {
  name: string;
  height: number;
  size: number;
  format: string;
}
export interface ApiEmote {
  id: string;
  name: string;
  animated?: boolean | null;
  host?: { url: string; files?: ApiFile[] | null } | null;
}
export interface ApiActiveEmote {
  id: string;
  name: string;
  data?: ApiEmote | null;
}
export interface ApiSet {
  id: string;
  name: string;
  emotes?: ApiActiveEmote[] | null;
}
export interface ApiConnection {
  platform: string;
  emote_set_id?: string | null;
}
export interface ApiUser {
  id: string;
  username: string;
  connections?: ApiConnection[] | null;
}

type ApiEmoteSummary = Pick<ApiEmote, "id" | "name" | "animated">;

interface ApiSearchPage {
  count: number;
  items: ApiEmoteSummary[];
}

/** Validates the fields consumed from 7TV v3 and maps them to domain shapes. */
export class SevenTvMapper {
  public static readonly DISCORD_EMOJI_BYTES = 256 * 1024;

  public static isEmote(value: unknown): value is ApiEmote {
    if (!this.isRecord(value)) return false;
    const { host } = value;
    if (!this.isEmoteSummary(value)) return false;
    // The source URL is fetched, so only accept the public 7TV emote CDN path and simple filenames.
    if (host == null) return true;
    if (!this.isRecord(host) || typeof host.url !== "string") return false;
    const { files } = host;
    if (files != null && (!Array.isArray(files) || !files.every((file: unknown) => this.isFile(file)))) return false;
    // 7TV emits an empty URL when an emote has no image outputs.
    if (host.url === "" && (files == null || files.length === 0)) return true;
    return /^\/\/cdn\.7tv\.app\/emote\/[a-zA-Z0-9_-]+$/.test(host.url);
  }

  public static isSet(value: unknown): value is ApiSet {
    if (!this.isRecord(value) || !this.isId(value.id) || typeof value.name !== "string") return false;
    const count = value.emote_count;
    if (count !== undefined && !this.isNonNegativeInteger(count)) return false;
    // v3 omits emotes for a genuinely empty set. Don't mirror a truncated, non-empty set as empty.
    if (value.emotes == null) return count === undefined || count === 0;
    return Array.isArray(value.emotes) && (count === undefined || count === value.emotes.length) &&
      value.emotes.every((entry: unknown) =>
        this.isRecord(entry) && this.isId(entry.id) && typeof entry.name === "string" &&
        (entry.data == null || this.isEmote(entry.data)));
  }

  public static isUser(value: unknown): value is ApiUser {
    return this.isRecord(value) && this.isId(value.id) && typeof value.username === "string" &&
      (value.connections == null || (Array.isArray(value.connections) && value.connections.every((entry: unknown) =>
        this.isRecord(entry) && typeof entry.platform === "string" && (entry.emote_set_id == null || this.isId(entry.emote_set_id)))));
  }

  public static searchPage(value: unknown): ApiSearchPage | null {
    if (!this.isRecord(value) || (value.errors !== undefined &&
      (!Array.isArray(value.errors) || value.errors.length > 0))) return null;
    if (!this.isRecord(value.data) || !this.isRecord(value.data.emotes)) return null;
    const { count, items } = value.data.emotes;
    if (!this.isNonNegativeInteger(count) || !Array.isArray(items) ||
      !items.every((item: unknown) => this.isEmoteSummary(item))) return null;
    return { count, items };
  }

  private static isEmoteSummary(value: unknown): value is ApiEmoteSummary {
    return this.isRecord(value) && this.isId(value.id) && typeof value.name === "string" &&
      (value.animated == null || typeof value.animated === "boolean");
  }

  private static isFile(file: unknown): file is ApiFile {
    return this.isRecord(file) && typeof file.name === "string" && /^\w+[.][a-zA-Z0-9]+$/.test(file.name) &&
      this.isNonNegativeInteger(file.height) && this.isNonNegativeInteger(file.size) && typeof file.format === "string";
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private static isId(value: unknown): value is string {
    return typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
  }

  private static isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  }

  public static emote(e: ApiEmoteSummary, name = e.name): SevenTvEmote {
    return { id: e.id, name, animated: e.animated === true };
  }

  /** Mirror the per-set alias, key on the emote id; entries without data cannot be mirrored. */
  public static set(s: ApiSet): SevenTvEmoteSet {
    const emotes: SevenTvEmote[] = [];
    for (const a of s.emotes ?? []) {
      if (!a.data || !a.data.host?.files?.length) continue;
      emotes.push(SevenTvMapper.emote(a.data, a.name));
    }
    return { id: s.id, name: s.name, emotes };
  }

  /** Active set is per platform connection: prefer Twitch, else the first with a set selected. */
  public static user(u: ApiUser): SevenTvUser {
    const withSet = (u.connections ?? []).filter((c) => c.emote_set_id);
    const chosen = withSet.find((c) => c.platform === "TWITCH") ?? withSet[0];
    return { id: u.id, username: u.username, activeSetId: chosen?.emote_set_id ?? null };
  }

  /**
   * Pick the source file for the image pipeline: the highest resolution that
   * already fits Discord's size limit (so it needs no shrinking), else the
   * smallest candidate. Animated: WEBP/GIF (WEBP wins ties), static: PNG/WEBP
   * (PNG wins ties). Returns the CDN URL.
   */
  public static sourceUrl(e: ApiEmote): string | null {
    const files = e.host?.files ?? [];
    const animated = e.animated === true;
    const rank: Record<string, number> = animated ? { WEBP: 2, GIF: 1 } : { PNG: 2, WEBP: 1 };
    const candidates = files.filter((f) => Object.hasOwn(rank, f.format));
    if (!candidates.length || !e.host) return null;
    const score = (f: ApiFile) => rank[f.format] ?? 0;
    const best = [...candidates].sort((a, b) => b.height - a.height || score(b) - score(a));
    const fitting = best.find((f) => f.size <= SevenTvMapper.DISCORD_EMOJI_BYTES);
    const smallest = candidates.reduce((a, b) => (b.size < a.size ? b : a));
    const file = fitting ?? smallest;
    return `https:${e.host.url}/${file.name}`;
  }
}
