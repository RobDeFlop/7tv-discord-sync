import {
  InvalidLinkError,
  MissingPermissionError,
  ServerQuotas,
  ServerState,
  type DiscordEmoji,
  type DiscordEmojiId,
  type EmojiImage,
  type ServerId,
  type ServerStateSnapshot,
  type SevenTvEmote,
  type SevenTvEmoteId,
  type SevenTvEmoteSet,
  type SevenTvSetId,
  type SevenTvUser,
  type SevenTvUserId,
  type TrendingPeriod,
  type WriteQueueProgress,
} from "../domain/index.ts";
import { ImagePipeline } from "../image/pipeline.ts";
import {
  DiscordPort,
  SevenTvPort,
  StorePort,
  type ImageResult,
  type SevenTvChange,
} from "../ports/index.ts";

export const MAX_EMOJI_BYTES = 256 * 1024;

interface FakeServer {
  boostLevel: number;
  emojis: DiscordEmoji[];
  canManage: boolean;
}

export class FakeDiscord extends DiscordPort {
  private readonly servers = new Map<ServerId, FakeServer>();
  private nextId = 1;
  private readonly images = new Map<DiscordEmojiId, EmojiImage>();

  public addServer(id: ServerId, opts: { boostLevel?: number } = {}): void {
    this.servers.set(id, { boostLevel: opts.boostLevel ?? 0, emojis: [], canManage: true });
  }

  private readonly progress = new Map<ServerId, WriteQueueProgress>();

  /** Pretend writes are queued, for /status. */
  public setQueueProgress(id: ServerId, progress: WriteQueueProgress): void {
    this.progress.set(id, progress);
  }

  public override queueProgress(id: ServerId): WriteQueueProgress {
    return this.progress.get(id) ?? super.queueProgress(id);
  }

  /** From now on writes fail with MissingPermissionError, as without Manage Expressions. */
  public revokeManageExpressions(id: ServerId): void {
    this.server(id).canManage = false;
  }

  public setBoostLevel(id: ServerId, boostLevel: number): void {
    this.server(id).boostLevel = boostLevel;
  }

  private readonly createFailures = new Map<ServerId, { remaining: number; error: Error }>();

  /** Let `successes` more creates work, then make every later create fail with `error`. */
  public failCreatesAfter(id: ServerId, successes: number, error: Error): void {
    this.createFailures.set(id, { remaining: successes, error });
  }

  public allowCreates(id: ServerId): void {
    this.createFailures.delete(id);
  }

  private quotaLookupCount = 0;

  /** How often slot limits were looked up. */
  public get quotaLookups(): number {
    return this.quotaLookupCount;
  }

  public override async getQuotas(id: ServerId): Promise<ServerQuotas> {
    this.quotaLookupCount++;
    return super.getQuotas(id);
  }

  public override async hasManageExpressions(id: ServerId): Promise<boolean> {
    return this.server(id).canManage;
  }

  /** Add an emoji as if an admin uploaded it by hand. Returns it. */
  public seedEmoji(id: ServerId, emoji: { name: string; animated: boolean }): DiscordEmoji {
    const created = { id: `emoji-${this.nextId++}`, ...emoji };
    this.server(id).emojis.push(created);
    return created;
  }

  /** Remove an emoji as if an admin deleted it by hand. */
  public removeEmojiByHand(id: ServerId, emojiId: string): void {
    const s = this.server(id);
    s.emojis = s.emojis.filter((e) => e.id !== emojiId);
  }

  /** Current emojis, for assertions. */
  public emojis(id: ServerId): DiscordEmoji[] {
    return this.server(id).emojis.map((e) => ({ ...e }));
  }

  public async getBoostLevel(id: ServerId): Promise<number> {
    return this.server(id).boostLevel;
  }

  public async listEmojis(id: ServerId): Promise<DiscordEmoji[]> {
    return this.emojis(id);
  }

  public seedEmojiImage(emojiId: DiscordEmojiId, image: EmojiImage): void {
    this.images.set(emojiId, { bytes: new Uint8Array(image.bytes), animated: image.animated });
  }

  public emojiImageSnapshot(emojiId: DiscordEmojiId): EmojiImage | null {
    const image = this.images.get(emojiId);
    return image ? { bytes: new Uint8Array(image.bytes), animated: image.animated } : null;
  }

  public async downloadEmojiImage(id: ServerId, emoji: DiscordEmoji): Promise<EmojiImage | null> {
    if (!this.server(id).emojis.some((e) => e.id === emoji.id)) return null;
    return this.emojiImageSnapshot(emoji.id);
  }

  public async createEmoji(id: ServerId, emoji: { name: string; image: EmojiImage }): Promise<DiscordEmoji> {
    const s = this.server(id);
    this.assertCanManage(id);
    const failure = this.createFailures.get(id);
    if (failure) {
      if (failure.remaining <= 0) throw failure.error;
      failure.remaining--;
    }
    const limit = new ServerQuotas(s.boostLevel).limit();
    const used = s.emojis.filter((e) => e.animated === emoji.image.animated).length;
    if (used >= limit) throw new Error("Maximum number of emojis reached");
    if (!/^[A-Za-z0-9_]{2,32}$/.test(emoji.name)) throw new Error(`Invalid emoji name: ${emoji.name}`);
    if (emoji.image.bytes.byteLength > MAX_EMOJI_BYTES) throw new Error("Emoji file too large");
    if (s.emojis.some((e) => e.name === emoji.name)) throw new Error(`Name taken: ${emoji.name}`);
    const created = this.seedEmoji(id, { name: emoji.name, animated: emoji.image.animated });
    this.seedEmojiImage(created.id, emoji.image);
    return created;
  }

  public async renameEmoji(id: ServerId, emojiId: string, name: string): Promise<void> {
    this.assertCanManage(id);
    const emoji = this.server(id).emojis.find((e) => e.id === emojiId);
    if (!emoji) throw new Error(`Unknown emoji ${emojiId}`);
    if (!/^[A-Za-z0-9_]{2,32}$/.test(name)) throw new Error(`Invalid emoji name: ${name}`);
    emoji.name = name;
  }

  public async deleteEmoji(id: ServerId, emojiId: string): Promise<void> {
    this.assertCanManage(id);
    this.removeEmojiByHand(id, emojiId);
  }

  private assertCanManage(id: ServerId): void {
    if (!this.server(id).canManage) throw new MissingPermissionError(id);
  }

  private server(id: ServerId): FakeServer {
    const s = this.servers.get(id);
    if (!s) throw new Error(`Unknown server ${id}`);
    return s;
  }
}

export class FakeSevenTv extends SevenTvPort {
  private readonly emotes = new Map<SevenTvEmoteId, SevenTvEmote>();
  private readonly users = new Map<SevenTvUserId, SevenTvUser>();
  private readonly sets = new Map<SevenTvSetId, SevenTvEmoteSet>();
  private readonly trending = new Map<TrendingPeriod, SevenTvEmoteId[]>();
  private readonly imageSizes = new Map<SevenTvEmoteId, number>();

  public addEmote(emote: SevenTvEmote, opts: { imageBytes?: number } = {}): void {
    this.emotes.set(emote.id, emote);
    this.imageSizes.set(emote.id, opts.imageBytes ?? 1024);
  }

  /** Rename an emote everywhere on 7TV, including inside sets. */
  public renameEmote(id: SevenTvEmoteId, name: string): void {
    const emote = this.emotes.get(id);
    if (!emote) throw new Error(`Unknown emote ${id}`);
    emote.name = name;
    for (const set of this.sets.values()) {
      for (const e of set.emotes) if (e.id === id) e.name = name;
    }
  }

  public addUser(user: SevenTvUser): void {
    this.users.set(user.id, user);
  }

  /** Create or replace a set. Emotes must already be registered with addEmote. */
  public setEmotes(setId: SevenTvSetId, name: string, emoteIds: SevenTvEmoteId[]): void {
    this.sets.set(setId, { id: setId, name, emotes: emoteIds.map((id) => this.emote(id)) });
  }

  public setActiveSet(userId: SevenTvUserId, setId: SevenTvSetId | null): void {
    const user = this.users.get(userId);
    if (!user) throw new Error(`Unknown user ${userId}`);
    user.activeSetId = setId;
  }

  public setTrending(period: TrendingPeriod, emoteIds: SevenTvEmoteId[]): void {
    this.trending.set(period, emoteIds);
  }

  private readonly unavailableImages = new Set<SevenTvEmoteId>();

  public disableDownload(id: SevenTvEmoteId): void {
    this.unavailableImages.add(id);
  }

  /** Make the next download of this emote report the given size. */
  public setImageSize(id: SevenTvEmoteId, bytes: number): void {
    this.imageSizes.set(id, bytes);
  }

  /** Push a change event to subscribers, as the EventAPI would. */
  public override emit(change: SevenTvChange): void {
    super.emit(change);
  }

  /** Links look like https://7tv.app/emotes/<id> and https://7tv.app/users/<id>. */
  public async resolveEmoteLink(link: string): Promise<SevenTvEmote> {
    const id = /^https:\/\/7tv\.app\/emotes\/([\w-]+)$/.exec(link)?.[1];
    const emote = id ? this.emotes.get(id) : undefined;
    if (!emote) throw new InvalidLinkError(link, "emote");
    return { ...emote };
  }

  public async findEmoteByExactName(name: string): Promise<SevenTvEmote | null> {
    const match = [...this.emotes.values()].find((emote) => this.matchesExactName(emote.name, name));
    return match ? { ...match } : null;
  }

  public async resolveUserLink(link: string): Promise<SevenTvUser> {
    const id = /^https:\/\/7tv\.app\/users\/([\w-]+)$/.exec(link)?.[1];
    const user = id ? this.users.get(id) : undefined;
    if (!user) throw new InvalidLinkError(link, "user");
    return { ...user };
  }

  public async getUser(id: SevenTvUserId): Promise<SevenTvUser | null> {
    const user = this.users.get(id);
    return user ? { ...user } : null;
  }

  public async getSet(id: SevenTvSetId): Promise<SevenTvEmoteSet | null> {
    const set = this.sets.get(id);
    return set ? { ...set, emotes: set.emotes.map((e) => ({ ...e })) } : null;
  }

  public async getTrending(period: TrendingPeriod, limit: number): Promise<SevenTvEmote[]> {
    return (this.trending.get(period) ?? []).slice(0, limit).map((id) => ({ ...this.emote(id) }));
  }

  private readonly downloads = new Map<SevenTvEmoteId, number>();

  /** How often an emote's image was downloaded. */
  public downloadCount(id: SevenTvEmoteId): number {
    return this.downloads.get(id) ?? 0;
  }

  public async downloadImage(id: SevenTvEmoteId): Promise<ImageResult> {
    this.downloads.set(id, this.downloadCount(id) + 1);
    const emote = this.emotes.get(id);
    if (!emote || this.unavailableImages.has(id)) return { ok: false, reason: "unavailable" };
    const size = this.imageSizes.get(id) ?? 0;
    if (size > MAX_EMOJI_BYTES) {
      return { ok: false, reason: "too-large", previewImage: { bytes: new Uint8Array(1024), animated: false } };
    }
    return { ok: true, image: { bytes: new Uint8Array(size), animated: emote.animated } };
  }

  private emote(id: SevenTvEmoteId): SevenTvEmote {
    const e = this.emotes.get(id);
    if (!e) throw new Error(`Unknown emote ${id}`);
    return e;
  }
}

export class FakeStore extends StorePort {
  private readonly snapshots = new Map<ServerId, ServerStateSnapshot>();

  public async load(server: ServerId): Promise<ServerState> {
    const snapshot = this.snapshots.get(server);
    return snapshot ? ServerState.fromSnapshot(structuredClone(snapshot)) : ServerState.empty();
  }

  public async save(server: ServerId, state: ServerState): Promise<void> {
    this.snapshots.set(server, structuredClone(state.toSnapshot()));
  }

  public async listServers(): Promise<ServerId[]> {
    return [...this.snapshots.keys()];
  }

  public async remove(server: ServerId): Promise<void> {
    this.snapshots.delete(server);
  }
}

/** An ImagePipeline that records its inputs and passes them through, or always fails with `failure`. */
export class FakeImagePipeline extends ImagePipeline {
  public readonly processed: { bytes: Uint8Array; animated: boolean }[] = [];

  public constructor(private readonly failure?: Extract<ImageResult, { ok: false }>) {
    super();
  }

  public override async prepare(bytes: Uint8Array, animated = false): Promise<ImageResult> {
    this.processed.push({ bytes, animated });
    return this.failure ?? { ok: true, image: { bytes, animated } };
  }
}
