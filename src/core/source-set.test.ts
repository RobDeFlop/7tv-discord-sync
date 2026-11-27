import { describe, expect, test } from "bun:test";
import {
  AddEmoteCommand,
  ConfigureLogChannelCommand,
  LinkSourceSetCommand,
  RemoveEmoteCommand,
  SyncCore,
  UnlinkSourceSetCommand,
} from "./index.ts";
import { FakeDiscord, FakeSevenTv, FakeStore } from "../testing/fakes.ts";

const S = "server-1";
const emoteLink = (id: string) => `https://7tv.app/emotes/${id}`;
const userLink = (id: string) => `https://7tv.app/users/${id}`;

function setup(opts: { boostLevel?: number } = {}) {
  const discord = new FakeDiscord();
  discord.addServer(S, { boostLevel: opts.boostLevel ?? 0 });
  const sevenTv = new FakeSevenTv();
  const store = new FakeStore();
  const core = new SyncCore(sevenTv, discord, store);
  const names = (animated?: boolean) =>
    discord
      .emojis(S)
      .filter((e) => animated === undefined || e.animated === animated)
      .map((e) => e.name)
      .sort();
  sevenTv.addUser({ id: "u1", username: "streamer", activeSetId: "setA" });
  const emotes = (ids: string[], animated = false) => {
    for (const id of ids) sevenTv.addEmote({ id, name: id.toUpperCase().repeat(2), animated });
  };
  return { discord, sevenTv, store, core, names, emotes };
}

const errors = (r: { feedback: { level: string; text: string }[] }) => r.feedback.filter((f) => f.level === "error");

describe("link", () => {
  test("mirrors the user's active set, keeping animated and static apart", async () => {
    const { sevenTv, core, names, emotes } = setup();
    emotes(["a", "b"]);
    emotes(["x"], true);
    sevenTv.setEmotes("setA", "Main", ["a", "b", "x"]);
    const r = await core.linkSourceSet(S, userLink("u1"));
    expect(errors(r)).toEqual([]);
    expect(names(false)).toEqual(["AA", "BB"]);
    expect(names(true)).toEqual(["XX"]);
    const st = await core.status(S);
    expect(st.linkedUserId).toBe("u1");
    expect(st.quotas.static.byTier.source).toBe(2);
  });

  test("invalid link gives a helpful error and links nothing", async () => {
    const { core } = setup();
    const r = await core.linkSourceSet(S, "https://example.com/x");
    expect(errors(r).length).toBe(1);
    expect(errors(r)[0]!.text).toContain("7TV");
    expect((await core.status(S)).linkedUserId).toBeNull();
  });
});

describe("reconcile mirrors the Source Set", () => {
  test("adds, removes and renames follow 7TV", async () => {
    const { sevenTv, core, names, emotes } = setup();
    emotes(["a", "b", "c"]);
    sevenTv.setEmotes("setA", "Main", ["a", "b"]);
    await core.linkSourceSet(S, userLink("u1"));

    sevenTv.setEmotes("setA", "Main", ["b", "c"]);
    sevenTv.renameEmote("b", "Bee");
    const r = await core.reconcile(S);
    expect(names()).toEqual(["Bee", "CC"]);
    expect(r.changes.some((c) => c.type === "renamed")).toBe(true);
  });

  test("an unresolvable active set preserves the mirror; no active set empties it", async () => {
    const { sevenTv, core, names, emotes } = setup();
    emotes(["a"]);
    sevenTv.setEmotes("setA", "Main", ["a"]);
    await core.linkSourceSet(S, userLink("u1"));
    sevenTv.setActiveSet("u1", "missing");
    const result = await core.reconcile(S);
    expect(names()).toEqual(["AA"]);
    expect(result.feedback.some((f) => f.level === "warning" && f.text.includes("Source Set"))).toBe(true);
    sevenTv.setActiveSet("u1", null);
    await core.reconcile(S);
    expect(names()).toEqual([]);
  });

  test("follows the user when their active set switches", async () => {
    const { sevenTv, core, names, emotes } = setup();
    emotes(["a", "b", "c"]);
    sevenTv.setEmotes("setA", "Main", ["a", "b"]);
    sevenTv.setEmotes("setB", "Other", ["c"]);
    await core.linkSourceSet(S, userLink("u1"));
    sevenTv.setActiveSet("u1", "setB");
    await core.reconcile(S);
    expect(names()).toEqual(["CC"]);
  });

  test("an emote that is both Requested and in the Source Set stays when it leaves the set", async () => {
    const { sevenTv, core, names, emotes } = setup();
    emotes(["a", "b"]);
    sevenTv.setEmotes("setA", "Main", ["a", "b"]);
    await core.linkSourceSet(S, userLink("u1"));
    await core.addEmote(S, emoteLink("a"));
    sevenTv.setEmotes("setA", "Main", []);
    await core.reconcile(S);
    expect(names()).toEqual(["AA"]);
  });

  test("renames avoid collisions with Reserved Slots and never touch them", async () => {
    const { sevenTv, discord, core, names, emotes } = setup();
    discord.seedEmoji(S, { name: "Bee", animated: false });
    emotes(["b"]);
    sevenTv.setEmotes("setA", "Main", ["b"]);
    await core.linkSourceSet(S, userLink("u1"));
    sevenTv.renameEmote("b", "Bee");
    await core.reconcile(S);
    expect(names()).toEqual(["Bee", "Bee_2"]);
  });

  test("a hand-deleted Source Set emote comes back", async () => {
    const { sevenTv, discord, core, names, emotes } = setup();
    emotes(["a"]);
    sevenTv.setEmotes("setA", "Main", ["a"]);
    await core.linkSourceSet(S, userLink("u1"));
    discord.removeEmojiByHand(S, discord.emojis(S)[0]!.id);
    await core.reconcile(S);
    expect(names()).toEqual(["AA"]);
  });
});

describe("emotes that do not fit", () => {
  async function fullWithOneFree() {
    const ctx = setup();
    for (let i = 0; i < 49; i++) ctx.discord.seedEmoji(S, { name: `hand${i}`, animated: false });
    ctx.emotes(["a", "b", "c"]);
    ctx.sevenTv.setEmotes("setA", "Main", ["a", "b", "c"]);
    return ctx;
  }

  test("are left out in set order with feedback and recorded as pending", async () => {
    const { core, names } = await fullWithOneFree();
    const r = await core.linkSourceSet(S, userLink("u1"));
    expect(names()).toContain("AA");
    expect(names()).not.toContain("BB");
    expect(names()).not.toContain("CC");
    expect(r.feedback.some((f) => f.text.includes("BB") && f.text.includes("CC"))).toBe(true);
    const st = await core.status(S);
    expect(st.problems.filter((p) => p.kind === "pending").map((p) => p.sevenTvEmoteId)).toEqual(["b", "c"]);
  });

  test("are added once slots free up, and the pending problem clears", async () => {
    const { core, discord, names } = await fullWithOneFree();
    await core.linkSourceSet(S, userLink("u1"));
    discord.removeEmojiByHand(S, discord.emojis(S).find((e) => e.name === "hand0")!.id);
    await core.reconcile(S);
    expect(names()).toContain("BB");
    expect(names()).not.toContain("CC");
    discord.removeEmojiByHand(S, discord.emojis(S).find((e) => e.name === "hand1")!.id);
    await core.reconcile(S);
    expect(names()).toContain("CC");
    expect((await core.status(S)).problems.filter((p) => p.kind === "pending")).toEqual([]);
  });

  test("repeated reconciles do not repeat the same feedback", async () => {
    const { core } = await fullWithOneFree();
    await core.linkSourceSet(S, userLink("u1"));
    const r = await core.reconcile(S);
    expect(r.feedback).toEqual([]);
  });

  test("a too-large Source Set emote is skipped with feedback", async () => {
    const { sevenTv, core, names, emotes } = setup();
    emotes(["a", "b"]);
    sevenTv.setImageSize("a", 300 * 1024);
    sevenTv.setEmotes("setA", "Main", ["a", "b"]);
    const r = await core.linkSourceSet(S, userLink("u1"));
    expect(names()).toEqual(["BB"]);
    expect(r.feedback.some((f) => f.text.includes("AA"))).toBe(true);
    expect((await core.status(S)).problems.map((p) => p.kind)).toContain("too-large");
  });
});

describe("add displaces Source Set emotes", () => {
  test("a failed replacement reports the displaced emote and restores it on the next sync", async () => {
    const { sevenTv, discord, core, names, emotes } = setup();
    for (let i = 0; i < 49; i++) discord.seedEmoji(S, { name: `hand${i}`, animated: false });
    emotes(["a", "r"]);
    sevenTv.setEmotes("setA", "Main", ["a"]);
    await core.linkSourceSet(S, userLink("u1"));
    discord.failCreatesAfter(S, 0, new Error("upload failed"));

    const result = await core.addEmote(S, emoteLink("r"));
    expect(errors(result)[0]?.text).toMatch(/AA.*next sync/);
    expect(names()).not.toContain("RR");
    expect((await core.status(S)).quotas.static.free).toBe(1);
    discord.allowCreates(S);
    await core.reconcile(S);
    expect(names()).toContain("AA");
    expect((await core.status(S)).quotas.static.byTier).toMatchObject({ requested: 0, source: 1, reserved: 49 });
  });

  test("a Requested Emote displaces a Source Set emote with feedback; it returns as pending, not re-added", async () => {
    const { sevenTv, discord, core, names, emotes } = setup();
    for (let i = 0; i < 49; i++) discord.seedEmoji(S, { name: `hand${i}`, animated: false });
    emotes(["a", "r"]);
    sevenTv.setEmotes("setA", "Main", ["a"]);
    await core.linkSourceSet(S, userLink("u1"));
    const r = await core.addEmote(S, emoteLink("r"));
    expect(names()).toContain("RR");
    expect(names()).not.toContain("AA");
    expect(r.feedback.some((f) => f.level === "warning")).toBe(true);
    await core.reconcile(S);
    expect(names()).not.toContain("AA");
    expect((await core.status(S)).problems.some((p) => p.kind === "pending")).toBe(true);
  });
});

describe("unlink", () => {
  async function linked() {
    const ctx = setup();
    ctx.discord.seedEmoji(S, { name: "hand", animated: false });
    ctx.emotes(["a", "b"]);
    ctx.sevenTv.setEmotes("setA", "Main", ["a", "b"]);
    await ctx.core.linkSourceSet(S, userLink("u1"));
    await ctx.core.addEmote(S, emoteLink("a"));
    return ctx;
  }

  test("delete removes Source Set emotes but keeps Requested and Reserved", async () => {
    const { core, names } = await linked();
    const r = await core.apply(S, new UnlinkSourceSetCommand(false));
    expect(errors(r)).toEqual([]);
    expect(names()).toEqual(["AA", "hand"]);
    expect((await core.status(S)).linkedUserId).toBeNull();
  });

  test("keep turns Source Set emotes into Reserved Slots that later syncs never touch", async () => {
    const { sevenTv, core, names } = await linked();
    await core.apply(S, new UnlinkSourceSetCommand(true));
    expect(names()).toEqual(["AA", "BB", "hand"]);
    const st = await core.status(S);
    expect(st.quotas.static.byTier.source).toBe(0);
    expect(st.quotas.static.byTier.reserved).toBe(2);
    sevenTv.setEmotes("setA", "Main", []);
    await core.reconcile(S);
    expect(names()).toEqual(["AA", "BB", "hand"]);
    const r = await core.removeEmote(S, "BB");
    expect(errors(r).length).toBe(1);
  });

  test("unlink without a link gives an error", async () => {
    const { core } = setup();
    const r = await core.apply(S, new UnlinkSourceSetCommand(true));
    expect(errors(r).length).toBe(1);
  });
});
