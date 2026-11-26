import type {
  SevenTvEmote,
  SevenTvEmoteId,
  SevenTvEmoteSet,
  SevenTvSetId,
  SevenTvUser,
  SevenTvUserId,
  TrendingPeriod,
} from "../../domain/index.ts";
import { InvalidLinkError, type ImageResult, type SevenTvChange, type SevenTvPort } from "../../ports/index.ts";
import { EventApiClient, type Dispatch, type SocketLike } from "./events.ts";
import { parseSevenTvLink } from "./links.ts";
import { mapEmote, mapSet, mapUser, pickSourceUrl, type ApiEmote, type ApiSet, type ApiUser } from "./mapping.ts";

const API = "https://7tv.io/v3";
const TRENDING_PAGE_SIZE = 100;
const CATEGORY: Record<TrendingPeriod, string> = {
  day: "TRENDING_DAY",
  week: "TRENDING_WEEK",
  month: "TRENDING_MONTH",
  "all-time": "TOP",
};

const SEARCH_QUERY =
  "query SearchEmotes($query: String!, $page: Int, $sort: Sort, $limit: Int, $filter: EmoteSearchFilter) { emotes(query: $query, page: $page, sort: $sort, limit: $limit, filter: $filter) { count items { id name animated host { url files { name width height frame_count size format } } } } }";

export interface SevenTvAdapterOptions {
  /** Turns downloaded source bytes into a Discord-ready image (the image pipeline). */
  processImage: (bytes: Uint8Array, animated: boolean) => Promise<ImageResult>;
  fetch?: typeof fetch;
  /** Open the EventAPI socket. Defaults to the global WebSocket. */
  createSocket?: (url: string) => SocketLike;
  /** Connect to the EventAPI while listeners exist. Default true. */
  enableEvents?: boolean;
  /** Polling fallback interval while listeners exist; 0 disables the timer. Default 5 minutes. */
  pollIntervalMs?: number;
}

/**
 * Thin 7TV adapter: HTTP + EventAPI + polling, no domain rules. Sets and users
 * it has looked up are watched for changes while at least one listener exists.
 */
export class SevenTvAdapter implements SevenTvPort {
  private readonly http: typeof fetch;
  private readonly listeners = new Set<(c: SevenTvChange) => void>();
  private readonly watchedSets = new Map<SevenTvSetId, string>();
  private readonly watchedUsers = new Map<SevenTvUserId, string | null | undefined>();
  private events: EventApiClient | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: SevenTvAdapterOptions) {
    this.http = opts.fetch ?? fetch;
  }

  async resolveEmoteLink(link: string): Promise<SevenTvEmote> {
    const parsed = parseSevenTvLink(link);
    if (!parsed || (parsed.kind !== "emote" && parsed.kind !== "unknown")) throw new InvalidLinkError(link);
    const emote = await this.getJson<ApiEmote>(`${API}/emotes/${parsed.id}`);
    if (!emote) throw new InvalidLinkError(link);
    return mapEmote(emote);
  }

  async resolveUserLink(link: string): Promise<SevenTvUser> {
    const parsed = parseSevenTvLink(link);
    if (!parsed || (parsed.kind !== "user" && parsed.kind !== "unknown")) throw new InvalidLinkError(link);
    const user = await this.getUser(parsed.id);
    if (!user) throw new InvalidLinkError(link);
    return user;
  }

  async getUser(id: SevenTvUserId): Promise<SevenTvUser | null> {
    const raw = await this.getJson<ApiUser>(`${API}/users/${id}`);
    if (!raw) return null;
    const user = mapUser(raw);
    this.watchUser(user);
    return user;
  }

  async getSet(id: SevenTvSetId): Promise<SevenTvEmoteSet | null> {
    const raw = await this.getJson<ApiSet>(`${API}/emote-sets/${id}`);
    if (!raw) return null;
    const set = mapSet(raw);
    this.watchSet(set);
    return set;
  }

  async getTrending(period: TrendingPeriod, limit: number): Promise<SevenTvEmote[]> {
    const out: SevenTvEmote[] = [];
    for (let page = 1; out.length < limit; page++) {
      const size = Math.min(TRENDING_PAGE_SIZE, limit - out.length);
      const res = await this.http(`${API}/gql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationName: "SearchEmotes",
          variables: {
            query: "",
            limit: size,
            page,
            sort: { value: "popularity", order: "DESCENDING" },
            filter: {
              category: CATEGORY[period],
              exact_match: false,
              case_sensitive: false,
              ignore_tags: false,
              zero_width: false,
              animated: false,
              aspect_ratio: "",
            },
          },
          query: SEARCH_QUERY,
        }),
      });
      if (!res.ok) throw new Error(`7TV trending failed: HTTP ${res.status}`);
      const body = (await res.json()) as { data?: { emotes?: { items?: ApiEmote[] } } };
      const items = body.data?.emotes?.items ?? [];
      out.push(...items.map((e) => mapEmote(e)));
      if (items.length < size) break;
    }
    return out.slice(0, limit);
  }

  async downloadImage(id: SevenTvEmoteId): Promise<ImageResult> {
    const emote = await this.getJson<ApiEmote>(`${API}/emotes/${id}`);
    if (!emote) return { ok: false, reason: "unavailable" };
    const url = pickSourceUrl(emote);
    if (!url) return { ok: false, reason: "unavailable" };
    let res: Response;
    try {
      res = await this.http(url);
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (!res.ok) return { ok: false, reason: "unavailable" };
    return this.opts.processImage(new Uint8Array(await res.arrayBuffer()), emote.animated === true);
  }

  subscribe(listener: (change: SevenTvChange) => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.startWatching();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopWatching();
    };
  }

  /** One polling round: re-fetch watched sets/users and emit what changed. Also run by the timer. */
  async pollOnce(): Promise<void> {
    for (const [id, before] of [...this.watchedUsers]) {
      const raw = await this.getJson<ApiUser>(`${API}/users/${id}`).catch(() => null);
      if (!raw) continue;
      const user = mapUser(raw);
      if (before === undefined) this.watchedUsers.set(id, user.activeSetId);
      else if (user.activeSetId !== before) {
        this.watchedUsers.set(id, user.activeSetId);
        this.emit({ type: "active-set-switched", userId: id });
      }
    }
    for (const [id, before] of [...this.watchedSets]) {
      const raw = await this.getJson<ApiSet>(`${API}/emote-sets/${id}`).catch(() => null);
      if (!raw) continue;
      const sig = signature(mapSet(raw));
      if (before === "") this.watchedSets.set(id, sig);
      else if (sig !== before) {
        this.watchedSets.set(id, sig);
        this.emit({ type: "set-changed", setId: id });
      }
    }
  }

  private watchUser(user: SevenTvUser): void {
    this.watchedUsers.set(user.id, user.activeSetId);
    this.events?.watch("user.update", user.id);
  }

  private watchSet(set: SevenTvEmoteSet): void {
    this.watchedSets.set(set.id, signature(set));
    this.events?.watch("emote_set.update", set.id);
  }

  private startWatching(): void {
    if (this.opts.enableEvents !== false) {
      const createSocket = this.opts.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
      this.events = new EventApiClient({ createSocket, onDispatch: (d) => this.onDispatch(d) });
      for (const id of this.watchedUsers.keys()) this.events.watch("user.update", id);
      for (const id of this.watchedSets.keys()) this.events.watch("emote_set.update", id);
      this.events.start();
    }
    const interval = this.opts.pollIntervalMs ?? 5 * 60_000;
    if (interval > 0) {
      this.pollTimer = setInterval(() => void this.pollOnce().catch(() => {}), interval);
      (this.pollTimer as { unref?: () => void }).unref?.();
    }
  }

  private stopWatching(): void {
    this.events?.stop();
    this.events = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private onDispatch(d: Dispatch): void {
    if (d.type === "emote_set.update") {
      if (!this.watchedSets.has(d.objectId)) return;
      // forget the snapshot so the next poll does not report the same change again
      this.watchedSets.set(d.objectId, "");
      this.emit({ type: "set-changed", setId: d.objectId });
    } else {
      if (!this.watchedUsers.has(d.objectId)) return;
      const keys = d.changedKeys ?? [];
      if (keys.length > 0 && !keys.includes("connections")) return;
      this.watchedUsers.set(d.objectId, undefined);
      this.emit({ type: "active-set-switched", userId: d.objectId });
    }
  }

  private emit(change: SevenTvChange): void {
    for (const l of [...this.listeners]) l(change);
  }

  /** GET JSON; 400/404 mean "no such thing" and give null, anything else non-OK throws. */
  private async getJson<T>(url: string): Promise<T | null> {
    const res = await this.http(url);
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw new Error(`7TV request failed: HTTP ${res.status} ${url}`);
    return (await res.json()) as T;
  }
}

function signature(set: SevenTvEmoteSet): string {
  return set.emotes.map((e) => `${e.id}:${e.name}`).join("|") || "-";
}
