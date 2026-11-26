import { describe, expect, test } from "bun:test";
import { createSyncCore } from "./index.ts";
import { FakeDiscord, FakeSevenTv, FakeStore } from "../testing/fakes.ts";

const S = "server-1";
const link = (id: string) => `https://7tv.app/emotes/${id}`;

function setup(opts: { boostLevel?: number } = {}) {
  const discord = new FakeDiscord();
  discord.addServer(S, { boostLevel: opts.boostLevel ?? 0 });
  const sevenTv = new FakeSevenTv();
  const store = new FakeStore();
  const core = createSyncCore({ sevenTv, discord, store });
  const names = (animated?: boolean) =>
    discord
      .emojis(S)
      .filter((e) => animated === undefined || e.animated === animated)
      .map((e) => e.name)
      .sort();
  return { discord, sevenTv, store, core, names };
}

const errors = (r: { feedback: { level: string; text: string }[] }) => r.feedback.filter((f) => f.level === "error");

describe("Reserved Slots", () => {
  test("hand-added emojis become Reserved and are never touched; hand-deleted ones free their slot", async () => {
    const { discord, core } = setup();
    const a = discord.seedEmoji(S, { name: "handA", animated: false });
    discord.seedEmoji(S, { name: "handB", animated: true });
    await core.reconcile(S);
    expect((await core.status(S)).quotas.static.byTier.reserved).toBe(1);
    expect((await core.status(S)).quotas.animated.byTier.reserved).toBe(1);

    discord.removeEmojiByHand(S, a.id);
    await core.reconcile(S);
    const st = await core.status(S);
    expect(st.quotas.static.used).toBe(0);
    expect(st.quotas.static.free).toBe(50);
  });
});

describe("add", () => {
  test("creates a Requested Emote named after the 7TV emote", async () => {
    const { sevenTv, core, names, discord } = setup();
    sevenTv.addEmote({ id: "e1", name: "Pog", animated: false });
    const r = await core.apply(S, { type: "add", link: link("e1") });
    expect(errors(r)).toEqual([]);
    expect(names()).toEqual(["Pog"]);
    expect(discord.emojis(S)[0]!.animated).toBe(false);
    expect((await core.status(S)).quotas.static.byTier.requested).toBe(1);
  });

  test("optional name overrides the 7TV name", async () => {
    const { sevenTv, core, names } = setup();
    sevenTv.addEmote({ id: "e1", name: "Pog", animated: false });
    await core.apply(S, { type: "add", link: link("e1"), name: "mine" });
    expect(names()).toEqual(["mine"]);
  });

  test("invalid link gives a helpful error and creates nothing", async () => {
    const { core, names } = setup();
    const r = await core.apply(S, { type: "add", link: "https://example.com/nope" });
    expect(errors(r).length).toBe(1);
    expect(errors(r)[0]!.text).toContain("7TV");
    expect(names()).toEqual([]);
  });

  test("names are sanitised to [A-Za-z0-9_] and 2-32 chars", async () => {
    const { sevenTv, core, names } = setup();
    sevenTv.addEmote({ id: "e1", name: "cat-face!", animated: false });
    sevenTv.addEmote({ id: "e2", name: "a", animated: false });
    sevenTv.addEmote({ id: "e3", name: "x".repeat(40), animated: false });
    await core.apply(S, { type: "add", link: link("e1") });
    await core.apply(S, { type: "add", link: link("e2") });
    await core.apply(S, { type: "add", link: link("e3") });
    expect(names()).toEqual(["a_", "cat_face_", "x".repeat(32)].sort());
  });

  test("name collisions (including with Reserved Slots) get a suffix and feedback", async () => {
    const { sevenTv, discord, core, names } = setup();
    discord.seedEmoji(S, { name: "Pog", animated: false });
    sevenTv.addEmote({ id: "e1", name: "Pog", animated: false });
    sevenTv.addEmote({ id: "e2", name: "Pog", animated: false });
    const r1 = await core.apply(S, { type: "add", link: link("e1") });
    const r2 = await core.apply(S, { type: "add", link: link("e2") });
    expect(names()).toEqual(["Pog", "Pog_2", "Pog_3"]);
    expect(r1.feedback.some((f) => f.text.includes("Pog_2"))).toBe(true);
    expect(r2.feedback.some((f) => f.text.includes("Pog_3"))).toBe(true);
    expect((await core.status(S)).problems.some((p) => p.kind === "renamed-with-suffix")).toBe(true);
  });

  test("suffix keeps the name within 32 chars", async () => {
    const { sevenTv, discord, core, names } = setup();
    const long = "y".repeat(32);
    discord.seedEmoji(S, { name: long, animated: false });
    sevenTv.addEmote({ id: "e1", name: long, animated: false });
    await core.apply(S, { type: "add", link: link("e1") });
    expect(names()).toContain("y".repeat(30) + "_2");
  });

  test("adding an emote already present does not duplicate it", async () => {
    const { sevenTv, core, names } = setup();
    sevenTv.addEmote({ id: "e1", name: "Pog", animated: false });
    await core.apply(S, { type: "add", link: link("e1") });
    await core.apply(S, { type: "add", link: link("e1") });
    expect(names()).toEqual(["Pog"]);
  });
});

describe("quotas", () => {
  test("animated never falls back into static slots", async () => {
    const { sevenTv, discord, core, names } = setup();
    for (let i = 0; i < 50; i++) discord.seedEmoji(S, { name: `an${i}`, animated: true });
    sevenTv.addEmote({ id: "e1", name: "Dance", animated: true });
    sevenTv.addEmote({ id: "e2", name: "Still", animated: false });
    const r1 = await core.apply(S, { type: "add", link: link("e1") });
    const r2 = await core.apply(S, { type: "add", link: link("e2") });
    expect(errors(r1).length).toBe(1);
    expect(errors(r2)).toEqual([]);
    expect(names(false)).toEqual(["Still"]);
    expect(names(true).length).toBe(50);
  });

  test("full quota of Reserved + Requested gives a clear error and changes nothing", async () => {
    const { sevenTv, discord, core, names } = setup();
    for (let i = 0; i < 49; i++) discord.seedEmoji(S, { name: `hand${i}`, animated: false });
    sevenTv.addEmote({ id: "e1", name: "One", animated: false });
    sevenTv.addEmote({ id: "e2", name: "Two", animated: false });
    await core.apply(S, { type: "add", link: link("e1") });
    const r = await core.apply(S, { type: "add", link: link("e2") });
    expect(errors(r).length).toBe(1);
    expect(names()).not.toContain("Two");
    expect(names()).toContain("One");
    expect(names().length).toBe(50);
  });

  test("status reports used/free per quota and tier", async () => {
    const { sevenTv, discord, core } = setup();
    discord.seedEmoji(S, { name: "hand", animated: false });
    sevenTv.addEmote({ id: "e1", name: "One", animated: false });
    await core.apply(S, { type: "add", link: link("e1") });
    const st = await core.status(S);
    expect(st.quotas.static).toEqual({
      used: 2,
      free: 48,
      byTier: { reserved: 1, requested: 1, source: 0, trending: 0 },
    });
    expect(st.quotas.animated.free).toBe(50);
  });
});

describe("too-large images", () => {
  test("skipped with feedback and recorded as a problem", async () => {
    const { sevenTv, core, names } = setup();
    sevenTv.addEmote({ id: "e1", name: "Huge", animated: true }, { imageBytes: 300 * 1024 });
    const r = await core.apply(S, { type: "add", link: link("e1") });
    expect(errors(r).length).toBe(1);
    expect(names()).toEqual([]);
    expect((await core.status(S)).problems.map((p) => p.kind)).toContain("too-large");
  });
});

describe("Displacement by Precedence", () => {
  async function fullQuotaWithLowerTiers() {
    const ctx = setup();
    const { discord, store, sevenTv } = ctx;
    const state = await store.load(S);
    // 48 hand emojis (Reserved), 1 Source Set emote, 1 Trending Fill emote.
    for (let i = 0; i < 48; i++) discord.seedEmoji(S, { name: `hand${i}`, animated: false });
    const src = discord.seedEmoji(S, { name: "srcEmote", animated: false });
    const trend = discord.seedEmoji(S, { name: "trendEmote", animated: false });
    state.managedEmotes.push(
      { discordEmojiId: src.id, sevenTvEmoteId: "s1", tier: "source", quota: "static" },
      { discordEmojiId: trend.id, sevenTvEmoteId: "t1", tier: "trending", quota: "static" },
    );
    await store.save(S, state);
    for (const id of ["a", "b", "c"]) sevenTv.addEmote({ id, name: `new${id}`, animated: false });
    return ctx;
  }

  test("a Requested Emote displaces Trending Fill first, then Source Set, then errors; Reserved untouched", async () => {
    const { core, names } = await fullQuotaWithLowerTiers();
    const hand = names().filter((n) => n.startsWith("hand"));

    const r1 = await core.apply(S, { type: "add", link: link("a") });
    expect(errors(r1)).toEqual([]);
    expect(names()).not.toContain("trendEmote");
    expect(names()).toContain("srcEmote");
    expect(r1.feedback.some((f) => f.level === "warning")).toBe(true);

    await core.apply(S, { type: "add", link: link("b") });
    expect(names()).not.toContain("srcEmote");

    const r3 = await core.apply(S, { type: "add", link: link("c") });
    expect(errors(r3).length).toBe(1);
    expect(names()).toEqual(expect.arrayContaining([...hand, "newa", "newb"]));
    expect(names().length).toBe(50);
  });

  test("lower-tier emotes in the other quota are never displaced", async () => {
    const { core, sevenTv, names } = await fullQuotaWithLowerTiers();
    sevenTv.addEmote({ id: "anim", name: "anim", animated: true });
    await core.apply(S, { type: "add", link: link("anim") });
    expect(names()).toContain("srcEmote");
    expect(names()).toContain("trendEmote");
  });
});

describe("remove", () => {
  test("removes a Managed Emote", async () => {
    const { sevenTv, core, names } = setup();
    sevenTv.addEmote({ id: "e1", name: "Pog", animated: false });
    await core.apply(S, { type: "add", link: link("e1") });
    const r = await core.apply(S, { type: "remove", name: "Pog" });
    expect(errors(r)).toEqual([]);
    expect(names()).toEqual([]);
    expect((await core.status(S)).quotas.static.byTier.requested).toBe(0);
  });

  test("refuses Reserved Slots", async () => {
    const { discord, core, names } = setup();
    discord.seedEmoji(S, { name: "hand", animated: false });
    const r = await core.apply(S, { type: "remove", name: "hand" });
    expect(errors(r).length).toBe(1);
    expect(names()).toEqual(["hand"]);
  });

  test("unknown name gives an error", async () => {
    const { core } = setup();
    const r = await core.apply(S, { type: "remove", name: "ghost" });
    expect(errors(r).length).toBe(1);
  });
});
