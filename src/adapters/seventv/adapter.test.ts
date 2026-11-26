import { describe, expect, test } from "bun:test";
import { InvalidLinkError } from "../../domain/index.ts";
import { FakeImagePipeline } from "../../testing/fakes.ts";
import { SevenTvAdapter } from "./adapter.ts";
import { SevenTvFixtures as fx } from "./fixtures.ts";

type Route = (url: string, init?: RequestInit) => Response | undefined;

function setup(routes: Record<string, unknown | Uint8Array | number>) {
  const calls: { url: string; body?: unknown }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const hit = routes[url];
    if (typeof hit === "number") return new Response("nope", { status: hit });
    if (hit instanceof Uint8Array) return new Response(hit);
    if (hit === undefined) return new Response("not found", { status: 404 });
    return Response.json(hit);
  }) as typeof fetch;
  const pipeline = new FakeImagePipeline();
  const processed = pipeline.processed;
  const adapter = new SevenTvAdapter(pipeline, { fetch: fetchFn, enableEvents: false, pollIntervalMs: 0 });
  return { adapter, calls, processed };
}

const API = "https://7tv.io/v3";

describe("link resolution", () => {
  test("resolves an emote link to a SevenTvEmote", async () => {
    const { adapter } = setup({ [`${API}/emotes/${fx.EMOTE_ID}`]: fx.animatedEmote });
    expect(await adapter.resolveEmoteLink(`https://7tv.app/emotes/${fx.EMOTE_ID}`)).toEqual({
      id: fx.EMOTE_ID,
      name: "catJAM",
      animated: true,
    });
  });

  test("unparseable, wrong-kind and unknown links are InvalidLinkError", async () => {
    const { adapter } = setup({});
    await expect(adapter.resolveEmoteLink("nonsense")).rejects.toBeInstanceOf(InvalidLinkError);
    await expect(adapter.resolveEmoteLink(`https://7tv.app/users/${fx.USER_ID}`)).rejects.toBeInstanceOf(InvalidLinkError);
    await expect(adapter.resolveEmoteLink(`https://7tv.app/emotes/${fx.EMOTE_ID}`)).rejects.toBeInstanceOf(InvalidLinkError);
    await expect(adapter.resolveUserLink(`https://7tv.app/emotes/${fx.EMOTE_ID}`)).rejects.toBeInstanceOf(InvalidLinkError);
  });

  test("resolves a user link; active set comes from the Twitch connection", async () => {
    const { adapter } = setup({ [`${API}/users/${fx.USER_ID}`]: fx.user });
    expect(await adapter.resolveUserLink(`https://7tv.app/users/${fx.USER_ID}`)).toEqual({
      id: fx.USER_ID,
      username: "pascii_",
      activeSetId: fx.SET_ID,
    });
  });

  test("user with no selected set has activeSetId null", async () => {
    const { adapter } = setup({ [`${API}/users/${fx.USER_ID}`]: fx.userWithoutSet });
    expect((await adapter.getUser(fx.USER_ID))?.activeSetId).toBeNull();
  });
});

describe("lookups", () => {
  test("getUser and getSet return null when missing", async () => {
    const { adapter } = setup({});
    expect(await adapter.getUser(fx.USER_ID)).toBeNull();
    expect(await adapter.getSet(fx.SET_ID)).toBeNull();
  });

  test("getSet mirrors aliases and skips emotes without data", async () => {
    const { adapter } = setup({ [`${API}/emote-sets/${fx.SET_ID}`]: fx.emoteSet });
    expect(await adapter.getSet(fx.SET_ID)).toEqual({
      id: fx.SET_ID,
      name: "Main",
      emotes: [
        { id: fx.EMOTE_ID, name: "jam", animated: true },
        { id: fx.STATIC_ID, name: "Okayge", animated: false },
      ],
    });
  });

  test("server errors are not swallowed as missing", async () => {
    const { adapter } = setup({ [`${API}/emote-sets/${fx.SET_ID}`]: 500 });
    await expect(adapter.getSet(fx.SET_ID)).rejects.toThrow();
  });
});

describe("trending", () => {
  test("maps period to category and returns emotes", async () => {
    const { adapter, calls } = setup({ [`${API}/gql`]: fx.trendingResponse });
    const emotes = await adapter.getTrending("week", 2);
    expect(emotes.map((e) => e.id)).toEqual([fx.EMOTE_ID, fx.STATIC_ID]);
    expect((calls[0]!.body as any).variables.filter.category).toBe("TRENDING_WEEK");
    expect((calls[0]!.body as any).variables.limit).toBe(2);
  });

  test.each([
    ["day", "TRENDING_DAY"],
    ["month", "TRENDING_MONTH"],
    ["all-time", "TOP"],
  ] as const)("period %s", async (period, category) => {
    const { adapter, calls } = setup({ [`${API}/gql`]: fx.trendingResponse });
    await adapter.getTrending(period, 5);
    expect((calls[0]!.body as any).variables.filter.category).toBe(category);
  });

  test("pages until the limit is reached and truncates", async () => {
    const page = (n: number) => ({
      data: { emotes: { count: 300, items: Array.from({ length: 100 }, (_, i) => ({ ...fx.staticEmote, id: `E${n}-${i}` })) } },
    });
    let n = 0;
    const calls: any[] = [];
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init!.body)));
      return Response.json(page(++n));
    }) as unknown as typeof fetch;
    const adapter = new SevenTvAdapter(new FakeImagePipeline({ ok: false, reason: "unavailable" }), {
      fetch: fetchFn,
      enableEvents: false,
      pollIntervalMs: 0,
    });
    const emotes = await adapter.getTrending("day", 150);
    expect(emotes).toHaveLength(150);
    expect(calls.map((c) => c.variables.page)).toEqual([1, 2]);
  });
});

describe("downloadImage", () => {
  const bytes = new Uint8Array([1, 2, 3]);

  test("animated: downloads the best file that fits and hands it to the pipeline", async () => {
    const { adapter, calls, processed } = setup({
      [`${API}/emotes/${fx.EMOTE_ID}`]: fx.animatedEmote,
      [`https://cdn.7tv.app/emote/${fx.EMOTE_ID}/2x.webp`]: bytes,
    });
    const res = await adapter.downloadImage(fx.EMOTE_ID);
    expect(res.ok).toBe(true);
    expect(calls[1]!.url).toBe(`https://cdn.7tv.app/emote/${fx.EMOTE_ID}/2x.webp`);
    expect(processed).toEqual([{ bytes, animated: true }]);
  });

  test("static: prefers the largest PNG", async () => {
    const { adapter, calls, processed } = setup({
      [`${API}/emotes/${fx.STATIC_ID}`]: fx.staticEmote,
      [`https://cdn.7tv.app/emote/${fx.STATIC_ID}/4x.png`]: bytes,
    });
    await adapter.downloadImage(fx.STATIC_ID);
    expect(calls[1]!.url).toBe(`https://cdn.7tv.app/emote/${fx.STATIC_ID}/4x.png`);
    expect(processed[0]!.animated).toBe(false);
  });

  test("unknown emote or failed CDN download is unavailable", async () => {
    const { adapter } = setup({ [`${API}/emotes/${fx.EMOTE_ID}`]: fx.animatedEmote });
    expect(await adapter.downloadImage("01MISSINGMISSINGMISSINGAAA")).toEqual({ ok: false, reason: "unavailable" });
    expect(await adapter.downloadImage(fx.EMOTE_ID)).toEqual({ ok: false, reason: "unavailable" });
  });

  test("passes through the pipeline's too-large verdict", async () => {
    const { calls: _c } = setup({});
    const fetchFn = (async (u: string) =>
      u.includes("cdn") ? new Response(bytes) : Response.json(fx.animatedEmote)) as unknown as typeof fetch;
    const adapter = new SevenTvAdapter(new FakeImagePipeline({ ok: false, reason: "too-large" }), {
      fetch: fetchFn,
      enableEvents: false,
      pollIntervalMs: 0,
    });
    expect(await adapter.downloadImage(fx.EMOTE_ID)).toEqual({ ok: false, reason: "too-large" });
  });
});
