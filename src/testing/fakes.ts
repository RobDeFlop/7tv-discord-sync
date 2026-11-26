import type {
  DiscordEmoji,
  EmojiImage,
  ServerId,
  ServerQuotas,
  ServerState,
  SevenTvEmote,
  SevenTvEmoteId,
  SevenTvEmoteSet,
  SevenTvSetId,
  SevenTvUser,
  SevenTvUserId,
  TrendingPeriod,
} from "../domain/index.ts";
import { emptyServerState } from "../domain/index.ts";
import {
  InvalidLinkError,
  type DiscordPort,
  type ImageResult,
  type SevenTvChange,
  type SevenTvPort,
  type StorePort,
} from "../ports/index.ts";

/** Discord's emoji slots per quota by boost level. */
export const SLOTS_BY_BOOST_LEVEL = [50, 100, 150, 250] as const;
export const MAX_EMOJI_BYTES = 256 * 1024;

interface FakeServer {
  boostLevel: number;
  emojis: DiscordEmoji[];
}

export class FakeDiscord implements DiscordPort {
  private servers = new Map<ServerId, FakeServer>();
  private nextId = 1;
  /** Image bytes by emoji id, to assert which 7TV image was uploaded. */
  readonly images = new Map<string, EmojiImage>();

  addServer(id: ServerId, opts: { boostLevel?: number } = {}): void {
    this.servers.set(id, { boostLevel: opts.boostLevel ?? 0, emojis: [] });
  }

  setBoostLevel(id: ServerId, boostLevel: number): void {
    this.server(id).boostLevel = boostLevel;
  }

  /** Add an emoji as if an admin uploaded it by hand. Returns it. */
  seedEmoji(id: ServerId, emoji: { name: string; animated: boolean }): DiscordEmoji {
    const created = { id: `emoji-${this.nextId++}`, ...emoji };
    this.server(id).emojis.push(created);
    return created;
  }

  /** Remove an emoji as if an admin deleted it by hand. */
  removeEmojiByHand(id: ServerId, emojiId: string): void {
    const s = this.server(id);
    s.emojis = s.emojis.filter((e) => e.id !== emojiId);
  }

  /** Current emojis, for assertions. */
  emojis(id: ServerId): DiscordEmoji[] {
    return this.server(id).emojis.map((e) => ({ ...e }));
  }

  async getQuotas(id: ServerId): Promise<ServerQuotas> {
    const level = this.server(id).boostLevel;
    const limit = SLOTS_BY_BOOST_LEVEL[Math.min(level, 3)]!;
    return { boostLevel: level, limits: { static: limit, animated: limit } };
  }

  async listEmojis(id: ServerId): Promise<DiscordEmoji[]> {
    return this.emojis(id);
  }

  async createEmoji(
    id: ServerId,
    emoji: { name: string; image: EmojiImage },
  ): Promise<DiscordEmoji> {
    const s = this.server(id);
    const limit = (await this.getQuotas(id)).limits[emoji.image.animated ? "animated" : "static"];
    const used = s.emojis.filter((e) => e.animated === emoji.image.animated).length;
    if (used >= limit) throw new Error("Maximum number of emojis reached");
    if (!/^[A-Za-z0-9_]{2,32}$/.test(emoji.name)) throw new Error(`Invalid emoji name: ${emoji.name}`);
    if (emoji.image.bytes.byteLength > MAX_EMOJI_BYTES) throw new Error("Emoji file too large");
    if (s.emojis.some((e) => e.name === emoji.name)) throw new Error(`Name taken: ${emoji.name}`);
    const created = this.seedEmoji(id, { name: emoji.name, animated: emoji.image.animated });
    this.images.set(created.id, emoji.image);
    return created;
  }

  async renameEmoji(id: ServerId, emojiId: string, name: string): Promise<void> {
    const emoji = this.server(id).emojis.find((e) => e.id === emojiId);
    if (!emoji) throw new Error(`Unknown emoji ${emojiId}`);
    if (!/^[A-Za-z0-9_]{2,32}$/.test(name)) throw new Error(`Invalid emoji name: ${name}`);
    emoji.name = name;
  }

  async deleteEmoji(id: ServerId, emojiId: string): Promise<void> {
    this.removeEmojiByHand(id, emojiId);
  }

  private server(id: ServerId): FakeServer {
    const s = this.servers.get(id);
    if (!s) throw new Error(`Unknown server ${id}`);
    return s;
  }
}

export class FakeSevenTv implements SevenTvPort {
  private emotes = new Map<SevenTvEmoteId, SevenTvEmote>();
  private users = new Map<SevenTvUserId, SevenTvUser>();
  private sets = new Map<SevenTvSetId, SevenTvEmoteSet>();
  private trending = new Map<TrendingPeriod, SevenTvEmoteId[]>();
  private imageSizes = new Map<SevenTvEmoteId, number>();
  private listeners = new Set<(change: SevenTvChange) => void>();

  addEmote(emote: SevenTvEmote, opts: { imageBytes?: number } = {}): void {
    this.emotes.set(emote.id, emote);
    this.imageSizes.set(emote.id, opts.imageBytes ?? 1024);
  }

  /** Rename an emote everywhere on 7TV, including inside sets. */
  renameEmote(id: SevenTvEmoteId, name: string): void {
    const emote = this.emotes.get(id);
    if (!emote) throw new Error(`Unknown emote ${id}`);
    emote.name = name;
    for (const set of this.sets.values()) {
      for (const e of set.emotes) if (e.id === id) e.name = name;
    }
  }

  addUser(user: SevenTvUser): void {
    this.users.set(user.id, user);
  }

  /** Create or replace a set. Emotes must already be registered with addEmote. */
  setEmotes(setId: SevenTvSetId, name: string, emoteIds: SevenTvEmoteId[]): void {
    this.sets.set(setId, { id: setId, name, emotes: emoteIds.map((id) => this.emote(id)) });
  }

  setActiveSet(userId: SevenTvUserId, setId: SevenTvSetId | null): void {
    const user = this.users.get(userId);
    if (!user) throw new Error(`Unknown user ${userId}`);
    user.activeSetId = setId;
  }

  setTrending(period: TrendingPeriod, emoteIds: SevenTvEmoteId[]): void {
    this.trending.set(period, emoteIds);
  }

  /** Make the next download of this emote report the given size. */
  setImageSize(id: SevenTvEmoteId, bytes: number): void {
    this.imageSizes.set(id, bytes);
  }

  /** Push a change event to subscribers, as the EventAPI would. */
  emit(change: SevenTvChange): void {
    for (const l of this.listeners) l(change);
  }

  /** Links look like https://7tv.app/emotes/<id> and https://7tv.app/users/<id>. */
  async resolveEmoteLink(link: string): Promise<SevenTvEmote> {
    const id = /^https:\/\/7tv\.app\/emotes\/([\w-]+)$/.exec(link)?.[1];
    const emote = id ? this.emotes.get(id) : undefined;
    if (!emote) throw new InvalidLinkError(link);
    return { ...emote };
  }

  async resolveUserLink(link: string): Promise<SevenTvUser> {
    const id = /^https:\/\/7tv\.app\/users\/([\w-]+)$/.exec(link)?.[1];
    const user = id ? this.users.get(id) : undefined;
    if (!user) throw new InvalidLinkError(link);
    return { ...user };
  }

  async getUser(id: SevenTvUserId): Promise<SevenTvUser | null> {
    const user = this.users.get(id);
    return user ? { ...user } : null;
  }

  async getSet(id: SevenTvSetId): Promise<SevenTvEmoteSet | null> {
    const set = this.sets.get(id);
    return set ? { ...set, emotes: set.emotes.map((e) => ({ ...e })) } : null;
  }

  async getTrending(period: TrendingPeriod, limit: number): Promise<SevenTvEmote[]> {
    return (this.trending.get(period) ?? []).slice(0, limit).map((id) => ({ ...this.emote(id) }));
  }

  async downloadImage(id: SevenTvEmoteId): Promise<ImageResult> {
    const emote = this.emotes.get(id);
    if (!emote) return { ok: false, reason: "unavailable" };
    const size = this.imageSizes.get(id) ?? 0;
    if (size > MAX_EMOJI_BYTES) return { ok: false, reason: "too-large" };
    return { ok: true, image: { bytes: new Uint8Array(size), animated: emote.animated } };
  }

  subscribe(listener: (change: SevenTvChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emote(id: SevenTvEmoteId): SevenTvEmote {
    const e = this.emotes.get(id);
    if (!e) throw new Error(`Unknown emote ${id}`);
    return e;
  }
}

export class FakeStore implements StorePort {
  private states = new Map<ServerId, ServerState>();

  async load(server: ServerId): Promise<ServerState> {
    const state = this.states.get(server);
    return state ? structuredClone(state) : emptyServerState();
  }

  async save(server: ServerId, state: ServerState): Promise<void> {
    this.states.set(server, structuredClone(state));
  }

  async listServers(): Promise<ServerId[]> {
    return [...this.states.keys()];
  }

  async remove(server: ServerId): Promise<void> {
    this.states.delete(server);
  }
}
