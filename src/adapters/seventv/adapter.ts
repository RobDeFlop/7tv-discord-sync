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
import { Logger, LogLevel } from "../../logger.ts";
import { SevenTvPort, type ImageResult, type SevenTvChange } from "../../ports/index.ts";
import { EventApiClient, WebSocketEventSocket, type Dispatch, type EventSocket } from "./events.ts";
import { SevenTvLink } from "./links.ts";
import { SevenTvMapper } from "./mapping.ts";

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

/** Network, HTTP or payload failure; not a missing emote, set or user. */
export class SevenTvRequestError extends Error {
  public constructor(message: string, public readonly status?: number, options?: ErrorOptions) {
    super(message, options);
  }
}

export class SevenTvSearchError extends SevenTvRequestError {}

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
    if (!parsed || !parsed.canBe("emote")) throw new InvalidLinkError("emote");
    const emote = await this.getJson(`${API}/emotes/${parsed.id}`, (value) => SevenTvMapper.isEmote(value));
    if (!emote) throw new InvalidLinkError("emote");
    return SevenTvMapper.emote(emote);
  }

  public async resolveUserLink(link: string): Promise<SevenTvUser> {
    const parsed = SevenTvLink.parse(link);
    if (!parsed || !parsed.canBe("user")) throw new InvalidLinkError("user");
    const user = await this.getUser(parsed.id);
    if (!user) throw new InvalidLinkError("user");
    return user;
  }

  public async getUser(id: SevenTvUserId): Promise<SevenTvUser | null> {
    const raw = await this.getJson(`${API}/users/${id}`, (value) => SevenTvMapper.isUser(value));
    if (!raw) return null;
    const user = SevenTvMapper.user(raw);
    this.watchUser(user);
    return user;
  }

  public async getSet(id: SevenTvSetId): Promise<SevenTvEmoteSet | null> {
    const raw = await this.getJson(`${API}/emote-sets/${id}`, (value) => SevenTvMapper.isSet(value));
    if (!raw) return null;
    const set = SevenTvMapper.set(raw);
    this.watchSet(set);
    return set;
  }

  public async getTrending(period: TrendingPeriod, limit: number): Promise<SevenTvEmote[]> {
    const out: SevenTvEmote[] = [];
    for (let page = 1; out.length < limit; page++) {
      const size = Math.min(SEARCH_PAGE_SIZE, limit - out.length);
      const { items } = await this.searchPage("", CATEGORY[period], false, page, size);
      out.push(...items.map((e) => SevenTvMapper.emote(e)));
      if (items.length < size) break;
    }
    return out.slice(0, limit);
  }

  public async findEmoteByExactName(name: string): Promise<SevenTvEmote | null> {
    for (let page = 1; ; page++) {
      const { items, count } = await this.searchPage(name, CATEGORY["all-time"], true, page, SEARCH_PAGE_SIZE);
      const match = items.find((item) => this.matchesExactName(item.name, name));
      if (match) return SevenTvMapper.emote(match);
      if (items.length < SEARCH_PAGE_SIZE || page * SEARCH_PAGE_SIZE >= count) return null;
    }
  }

  private async searchPage(query: string, category: string, nameOnly: boolean, page: number, limit: number) {
    const request: RequestInit = {
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
    };
    let status: number | undefined;
    try {
      const res = await this.http(`${API}/gql`, request);
      status = res.status;
      if (!res.ok) throw new SevenTvSearchError("7TV search returned an HTTP error", status);
      const json: unknown = await res.json();
      const result = SevenTvMapper.searchPage(json);
      if (!result) throw new SevenTvSearchError("7TV search returned an invalid result");
      return result;
    } catch (cause) {
      const error = cause instanceof SevenTvSearchError ? cause : new SevenTvSearchError("7TV search failed", status, { cause });
      Logger.write(LogLevel.warn, `seventv_search_failed operation=${nameOnly ? "exact_name" : "trending"} page=${page} ${Logger.failure(error)}`);
      throw error;
    }
  }

  public async downloadImage(id: SevenTvEmoteId): Promise<ImageResult> {
    const emote = await this.getJson(`${API}/emotes/${id}`, (value) => SevenTvMapper.isEmote(value)).catch((error: unknown) => {
      // Don't cache a metadata outage as a permanent skip in Trending Fill.
      Logger.write(LogLevel.warn, `seventv_image_lookup_failed operation=lookup_emote emote=${Logger.field(id)} ${Logger.failure(error)}`);
      throw error;
    });
    if (!emote) return SevenTvAdapter.imageUnavailable(id, "lookup_emote", "reason=not_found");
    const url = SevenTvMapper.sourceUrl(emote);
    if (!url) return SevenTvAdapter.imageUnavailable(id, "select_source", "reason=no_supported_file");
    let operation = "download_cdn";
    try {
      const res = await this.http(url, { redirect: "error" });
      if (!res.ok) return SevenTvAdapter.imageUnavailable(id, operation, `status=${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      operation = "prepare_image";
      return await this.imagePipeline.prepare(bytes, emote.animated ?? false);
    } catch (error) {
      return SevenTvAdapter.imageUnavailable(id, operation, Logger.failure(error));
    }
  }

  private static imageUnavailable(id: SevenTvEmoteId, operation: string, details: string): ImageResult {
    Logger.write(LogLevel.warn, `seventv_image_unavailable operation=${operation} emote=${Logger.field(id)} ${details}`);
    return { ok: false, reason: "unavailable" };
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
      const raw = await this.pollJson("get_user", id, `${API}/users/${id}`, (value) => SevenTvMapper.isUser(value));
      if (!raw) continue;
      const user = SevenTvMapper.user(raw);
      if (before === undefined) this.watchedUsers.set(id, user.activeSetId);
      else if (user.activeSetId !== before) {
        this.watchedUsers.set(id, user.activeSetId);
        this.emit({ type: "active-set-switched", userId: id });
      }
    }
    for (const [id, before] of [...this.watchedSets]) {
      const raw = await this.pollJson("get_set", id, `${API}/emote-sets/${id}`, (value) => SevenTvMapper.isSet(value));
      if (!raw) continue;
      const sig = SevenTvAdapter.signature(SevenTvMapper.set(raw));
      if (before === "") this.watchedSets.set(id, sig);
      else if (sig !== before) {
        this.watchedSets.set(id, sig);
        this.emit({ type: "set-changed", setId: id });
      }
    }
  }

  private async pollJson<T>(operation: string, id: string, url: string, valid: (payload: unknown) => payload is T): Promise<T | null> {
    const fields = `operation=${operation} object=${Logger.field(id)}`;
    try {
      const result = await this.getJson(url, valid);
      if (!result) Logger.write(LogLevel.warn, `seventv_poll_failed ${fields} reason=not_found`);
      return result;
    } catch (error) {
      Logger.write(LogLevel.warn, `seventv_poll_failed ${fields} ${Logger.failure(error)}`);
      return null;
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
      this.pollTimer = setInterval(() => {
        void this.pollOnce().catch((error: unknown) =>
          Logger.write(LogLevel.error, `seventv_poll_failed operation=poll_round ${Logger.failure(error)}`),
        );
      }, interval);
      this.pollTimer.unref();
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
      const keys = d.changedKeys;
      if (keys.length > 0 && !keys.includes("connections")) return;
      this.watchedUsers.set(d.objectId, undefined);
      this.emit({ type: "active-set-switched", userId: d.objectId });
    }
  }

  /** GET JSON; 400/404 mean "no such thing" and give null, anything else non-OK throws. */
  private async getJson<T>(url: string, valid: (payload: unknown) => payload is T): Promise<T | null> {
    let status: number | undefined;
    try {
      const res = await this.http(url);
      status = res.status;
      if (status === 404 || status === 400) return null;
      if (!res.ok) throw new SevenTvRequestError("7TV request returned an HTTP error", status);
      const json: unknown = await res.json();
      if (!valid(json)) throw new SevenTvRequestError("7TV response has an invalid payload");
      return json;
    } catch (cause) {
      if (cause instanceof SevenTvRequestError) throw cause;
      throw new SevenTvRequestError("7TV request failed", status, { cause });
    }
  }

  private static signature(set: SevenTvEmoteSet): string {
    return set.emotes.map((e) => `${e.id}:${e.name}`).join("|") || "-";
  }
}
