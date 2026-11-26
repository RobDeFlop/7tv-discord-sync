export type LinkKind = "emote" | "user" | "set" | "unknown";

/** A parsed 7TV link or bare id; the API decides whether the id actually exists. */
export class SevenTvLink {
  private static readonly URL_RE =
    /^https?:\/\/(?:www\.|old\.)?7tv\.app\/(emotes|users|emote-sets)\/([0-9A-Za-z]{24,26})(?:[/?#].*)?$/;
  private static readonly BARE_RE = /^[0-9A-Za-z]{24,26}$/;
  private static readonly KINDS = { emotes: "emote", users: "user", "emote-sets": "set" } as const;

  private constructor(
    public readonly kind: LinkKind,
    public readonly id: string,
  ) {}

  /** Null when the text is not a 7TV link or id. */
  public static parse(input: string): SevenTvLink | null {
    const text = input.trim();
    const m = SevenTvLink.URL_RE.exec(text);
    if (m) return new SevenTvLink(SevenTvLink.KINDS[m[1] as keyof typeof SevenTvLink.KINDS], m[2]!);
    if (SevenTvLink.BARE_RE.test(text)) return new SevenTvLink("unknown", text);
    return null;
  }

  /** Whether the link can point at `kind`: that kind itself, or a bare id of unknown kind. */
  public canBe(kind: "emote" | "user"): boolean {
    return this.kind === kind || this.kind === "unknown";
  }
}
