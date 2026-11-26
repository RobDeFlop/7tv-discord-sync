import type {
  EmojiImage,
  SevenTvEmote,
  SevenTvEmoteId,
  SevenTvEmoteSet,
  SevenTvSetId,
  SevenTvUser,
  SevenTvUserId,
  TrendingPeriod,
} from "../domain/index.ts";

export type ImageResult =
  | { ok: true; image: EmojiImage }
  | { ok: false; reason: "too-large" | "unavailable" };

export type SevenTvChange =
  | { type: "set-changed"; setId: SevenTvSetId }
  | { type: "active-set-switched"; userId: SevenTvUserId };

export type SevenTvListener = (change: SevenTvChange) => void;

export abstract class SevenTvPort {
  private readonly listeners = new Set<SevenTvListener>();

  /** Throws InvalidLinkError. */
  public abstract resolveEmoteLink(link: string): Promise<SevenTvEmote>;
  /** Throws InvalidLinkError. */
  public abstract resolveUserLink(link: string): Promise<SevenTvUser>;
  public abstract getUser(id: SevenTvUserId): Promise<SevenTvUser | null>;
  public abstract getSet(id: SevenTvSetId): Promise<SevenTvEmoteSet | null>;
  public abstract getTrending(period: TrendingPeriod, limit: number): Promise<SevenTvEmote[]>;
  /**
   * Download the emote ready for Discord. The adapter runs the image pipeline,
   * so a result is either under the size limit or a failure.
   */
  public abstract downloadImage(id: SevenTvEmoteId): Promise<ImageResult>;

  /** Returns an unsubscribe function. */
  public subscribe(listener: SevenTvListener): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.onFirstListener();
    return () => {
      if (!this.listeners.delete(listener)) return;
      if (this.listeners.size === 0) this.onNoListeners();
    };
  }

  /** Tell every subscriber about a change. */
  protected emit(change: SevenTvChange): void {
    for (const listener of [...this.listeners]) listener(change);
  }

  /** Hook: the first listener subscribed, so a real implementation can start watching. */
  protected onFirstListener(): void {}

  /** Hook: the last listener left, so a real implementation can stop watching. */
  protected onNoListeners(): void {}
}
