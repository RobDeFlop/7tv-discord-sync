import {
  InvalidLinkError,
  type SevenTvEmote,
  type SevenTvEmoteId,
  type SevenTvEmoteSet,
  type SevenTvSetId,
  type SevenTvUser,
  type SevenTvUserId,
  type TrendingPeriod,
} from "../../domain/index.ts";
import type { ImagePipeline } from "../../image/pipeline.ts";
import { SevenTvPort, type ImageResult, type SevenTvChange } from "../../ports/index.ts";
import { EventApiClient, WebSocketEventSocket, type Dispatch, type EventSocket } from "./events.ts";
import { SevenTvLink } from "./links.ts";
import { SevenTvMapper, type ApiEmote, type ApiSet, type ApiUser } from "./mapping.ts";

const API = "https://7tv.io/v3";
const SEARCH_PAGE_SIZE = 100;
const CATEGORY: Record<TrendingPeriod, string> = {
  day: "TRENDING_DAY",
  week: "TRENDING_WEEK",
  month: "TRENDING_MONTH",
  "all-time": "TOP",
};

const SEARCH_QUERY =
  "query SearchEmotes($query: String!, $page: Int, $sort: Sort, $limit: Int, $filter: EmoteSearchFilter) { emotes(query: $query, page: $page, sort: $sort, limit: $limit, filter: $filter) { count items { id name animated host { url files { name width height frame_count size format } } } } }";

export class SevenTvSearchError extends Error {}

export interface SevenTvAdapterOptions {
  fetch?: typeof fetch;
  /** Open the EventAPI socket. Defaults to the global WebSocket. */
  createSocket?: (url: string) => EventSocket;
  /** Connect to the EventAPI while listeners exist. Default true. */
  enableEvents?: boolean;
  /** Polling fallback interval while listeners exist; 0 disables the timer. Default 5 minutes. */
  pollIntervalMs?: number;
}

/**
 * Thin 7TV adapter: HTTP + EventAPI + polling, no domain rules. Sets and users
 * it has looked up are watched for changes while at least one listener exists.
 */
export class SevenTvAdapter extends SevenTvPort {
  private readonly http: typeof fetch;
  private readonly watchedSets = new Map<SevenTvSetId, string>();
  private readonly watchedUsers = new Map<SevenTvUserId, string | null | undefined>();
  private events: EventApiClient | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  public constructor(
    private readonly imagePipeline: ImagePipeline,
    private readonly opts: SevenTvAdapterOptions = {},
  ) {
    super();
    this.http = opts.fetch ?? fetch;
  }

  public async resolveEmoteLink(link: string): Promise<SevenTvEmote> {
    const parsed = SevenTvLink.parse(link);
    if (!parsed || !parsed.canBe("emote")) throw new InvalidLinkError(link, "emote");
    const emote = await this.getJson<ApiEmote>(`${API}/emotes/${parsed.id}`);
    if (!emote) throw new InvalidLinkError(link, "emote");
    return SevenTvMapper.emote(emote);
  }

  public async resolveUserLink(link: string): Promise<SevenTvUser> {
    const parsed = SevenTvLink.parse(link);
    if (!parsed || !parsed.canBe("user")) throw new InvalidLinkError(link, "user");
    const user = await this.getUser(parsed.id);
    if (!user) throw new InvalidLinkError(link, "user");
    return user;
  }

  public async getUser(id: SevenTvUserId): Promise<SevenTvUser | null> {
    const raw = await this.getJson<ApiUser>(`${API}/users/${id}`);
    if (!raw) return null;
    const user = SevenTvMapper.user(raw);
    this.watchUser(user);
    return user;
  }

  public async getSet(id: SevenTvSetId): Promise<SevenTvEmoteSet | null> {
    const raw = await this.getJson<ApiSet>(`${API}/emote-sets/${id}`);
    if (!raw) return null;
    const set = SevenTvMapper.set(raw);
    this.watchSet(set);
    return set;
  }

  public async getTrending(period: TrendingPeriod, limit: number): Promise<SevenTvEmote[]> {
    const out: SevenTvEmote[] = [];
    for (let page = 1; out.length < limit; page++) {
      const size = Math.min(SEARCH_PAGE_SIZE, limit - out.length);
      const body = await this.searchPage("", CATEGORY[period], false, page, size);
      const items = body.data?.emotes?.items ?? [];
      out.push(...items.map((e) => SevenTvMapper.emote(e)));
      if (items.length < size) break;
    }
    return out.slice(0, limit);
  }

  public async findEmoteByExactName(name: string): Promise<SevenTvEmote | null> {
    for (let page = 1; ; page++) {
      const body = await this.searchPage(name, CATEGORY["all-time"], true, page, SEARCH_PAGE_SIZE);
      const result = body.data?.emotes;
      if (body.errors?.length || !Array.isArray(result?.items)) throw new SevenTvSearchError("7TV search returned an invalid result");
      const { items, count } = result;
      const match = items.find((item) => this.matchesExactName(item.name, name));
      if (match) return SevenTvMapper.emote(match);
      if (items.length < SEARCH_PAGE_SIZE || page * SEARCH_PAGE_SIZE >= count) return null;
    }
  }

  private async searchPage(query: string, category: string, nameOnly: boolean, page: number, limit: number) {
    const res = await this.http(`${API}/gql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operationName: "SearchEmotes",
        variables: {
          query,
          limit,
          page,
          sort: { value: "popularity", order: "DESCENDING" },
          filter: {
            category,
            exact_match: nameOnly,
            case_sensitive: false,
            ignore_tags: nameOnly,
            zero_width: false,
            animated: false,
            aspect_ratio: "",
          },
        },
        query: SEARCH_QUERY,
      }),
    });
    if (!res.ok) throw new SevenTvSearchError(`7TV search failed: HTTP ${res.status}`);
    return (await res.json()) as { errors?: unknown[]; data?: { emotes?: { count: number; items: ApiEmote[] } } };
  }

  public async downloadImage(id: SevenTvEmoteId): Promise<ImageResult> {
    const emote = await this.getJson<ApiEmote>(`${API}/emotes/${id}`);
    if (!emote) return { ok: false, reason: "unavailable" };
    const url = SevenTvMapper.sourceUrl(emote);
    if (!url) return { ok: false, reason: "unavailable" };
    let res: Response;
    try {
      res = await this.http(url);
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (!res.ok) return { ok: false, reason: "unavailable" };
    return this.imagePipeline.prepare(new Uint8Array(await res.arrayBuffer()), emote.animated === true);
  }

  protected override onFirstListener(): void {
    this.startWatching();
  }

  protected override onNoListeners(): void {
    this.stopWatching();
  }

  /** One polling round: re-fetch watched sets/users and emit what changed. Also run by the timer. */
  public async pollOnce(): Promise<void> {
    for (const [id, before] of [...this.watchedUsers]) {
      const raw = await this.getJson<ApiUser>(`${API}/users/${id}`).catch(() => null);
      if (!raw) continue;
      const user = SevenTvMapper.user(raw);
      if (before === undefined) this.watchedUsers.set(id, user.activeSetId);
      else if (user.activeSetId !== before) {
        this.watchedUsers.set(id, user.activeSetId);
        this.emit({ type: "active-set-switched", userId: id });
      }
    }
    for (const [id, before] of [...this.watchedSets]) {
      const raw = await this.getJson<ApiSet>(`${API}/emote-sets/${id}`).catch(() => null);
      if (!raw) continue;
      const sig = SevenTvAdapter.signature(SevenTvMapper.set(raw));
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
    this.watchedSets.set(set.id, SevenTvAdapter.signature(set));
    this.events?.watch("emote_set.update", set.id);
  }

  private startWatching(): void {
    if (this.opts.enableEvents !== false) {
      const createSocket = this.opts.createSocket ?? ((url: string) => new WebSocketEventSocket(url));
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

  /** GET JSON; 400/404 mean "no such thing" and give null, anything else non-OK throws. */
  private async getJson<T>(url: string): Promise<T | null> {
    const res = await this.http(url);
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw new Error(`7TV request failed: HTTP ${res.status} ${url}`);
    return (await res.json()) as T;
  }

  private static signature(set: SevenTvEmoteSet): string {
    return set.emotes.map((e) => `${e.id}:${e.name}`).join("|") || "-";
  }
}
