export type ParsedLink = { kind: "emote" | "user" | "set" | "unknown"; id: string };

const URL_RE = /^https?:\/\/(?:www\.|old\.)?7tv\.app\/(emotes|users|emote-sets)\/([0-9A-Za-z]{24,26})(?:[/?#].*)?$/;
const BARE_RE = /^[0-9A-Za-z]{24,26}$/;
const KINDS = { emotes: "emote", users: "user", "emote-sets": "set" } as const;

/** Pure link parsing; the API decides whether the id actually exists. */
export function parseSevenTvLink(input: string): ParsedLink | null {
  const text = input.trim();
  const m = URL_RE.exec(text);
  if (m) return { kind: KINDS[m[1] as keyof typeof KINDS], id: m[2]! };
  if (BARE_RE.test(text)) return { kind: "unknown", id: text };
  return null;
}
