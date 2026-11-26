import type { SevenTvEmote, SevenTvUser } from "../../domain/index.ts";

// Shapes of the 7TV v3 responses we read (only the fields we use).
export interface ApiFile {
  name: string;
  width: number;
  height: number;
  frame_count: number;
  size: number;
  format: string;
}
export interface ApiEmote {
  id: string;
  name: string;
  animated?: boolean;
  host?: { url: string; files?: ApiFile[] };
}
export interface ApiActiveEmote {
  id: string;
  name: string;
  data?: ApiEmote;
}
export interface ApiSet {
  id: string;
  name: string;
  emotes?: ApiActiveEmote[];
}
export interface ApiConnection {
  platform: string;
  emote_set_id?: string | null;
}
export interface ApiUser {
  id: string;
  username: string;
  connections?: ApiConnection[];
}

export const DISCORD_EMOJI_BYTES = 256 * 1024;

export function mapEmote(e: ApiEmote, name = e.name): SevenTvEmote {
  return { id: e.id, name, animated: e.animated === true };
}

/** Mirror the per-set alias, key on the emote id; entries without data cannot be mirrored. */
export function mapSet(s: ApiSet) {
  const emotes: SevenTvEmote[] = [];
  for (const a of s.emotes ?? []) {
    if (!a.data || !a.data.host?.files?.length) continue;
    emotes.push(mapEmote(a.data, a.name));
  }
  return { id: s.id, name: s.name, emotes };
}

/** Active set is per platform connection: prefer Twitch, else the first with a set selected. */
export function mapUser(u: ApiUser): SevenTvUser {
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
export function pickSourceUrl(e: ApiEmote): string | null {
  const files = e.host?.files ?? [];
  const animated = e.animated === true;
  const rank: Record<string, number> = animated ? { WEBP: 2, GIF: 1 } : { PNG: 2, WEBP: 1 };
  const candidates = files.filter((f) => f.format in rank);
  if (!candidates.length || !e.host) return null;
  const score = (f: ApiFile) => rank[f.format] ?? 0;
  const best = [...candidates].sort((a, b) => b.height - a.height || score(b) - score(a));
  const fitting = best.find((f) => f.size <= DISCORD_EMOJI_BYTES);
  const smallest = candidates.reduce((a, b) => (b.size < a.size ? b : a));
  const file = fitting ?? smallest;
  return `https:${e.host.url}/${file.name}`;
}
