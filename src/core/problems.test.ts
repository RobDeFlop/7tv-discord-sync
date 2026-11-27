import { describe, expect, spyOn, test } from "bun:test";
import { SetTrendingCommand, SyncCore } from "./index.ts";
import { FakeDiscord, FakeSevenTv, FakeStore } from "../testing/fakes.ts";
import { addRequestedEmote } from "../testing/requested-emotes.ts";

const S = "server-1";
const userLink = "https://7tv.app/users/u1";
const TOO_BIG = 10 * 1024 * 1024;

function setup() {
  const discord = new FakeDiscord();
  discord.addServer(S, { boostLevel: 0 });
  const sevenTv = new FakeSevenTv();
  const core = new SyncCore(sevenTv, discord, new FakeStore());
  sevenTv.addUser({ id: "u1", username: "streamer", activeSetId: "setA" });
  const emotes = (ids: string[]) => {
    for (const id of ids) sevenTv.addEmote({ id, name: id.toUpperCase().repeat(2), animated: false });
  };
  const names = () => discord.emojis(S).map((e) => e.name).sort();
  const problems = async () => (await core.status(S)).problems.filter((p) => p.kind !== "pending");
  return { discord, sevenTv, core, emotes, names, problems };
}

const warnings = (r: { feedback: { level: string; text: string }[] }) => r.feedback.filter((f) => f.level === "warning");

describe("problems only show what is current", () => {
  test("a too-large problem goes away when the emote leaves the Source Set", async () => {
    const { sevenTv, core, emotes, problems } = setup();
    emotes(["big"]);
    sevenTv.setImageSize("big", TOO_BIG);
    sevenTv.setEmotes("setA", "Main", ["big"]);
    await core.linkSourceSet(S, userLink);
    expect(await problems()).toHaveLength(1);
    sevenTv.setEmotes("setA", "Main", []);
    await core.reconcile(S);
    expect(await problems()).toEqual([]);
  });

  test("a too-large problem goes away once the emote fits and is placed", async () => {
    const { sevenTv, core, emotes, names, problems } = setup();
    emotes(["big"]);
    sevenTv.setImageSize("big", TOO_BIG);
    sevenTv.setEmotes("setA", "Main", ["big"]);
    await core.linkSourceSet(S, userLink);
    sevenTv.setImageSize("big", 1024);
    await core.reconcile(S);
    expect(names()).toEqual(["BIGBIG"]);
    expect(await problems()).toEqual([]);
  });

  test("a renamed-with-suffix problem goes away when the emote leaves the set", async () => {
    const { discord, sevenTv, core, emotes, problems } = setup();
    emotes(["a"]);
    discord.seedEmoji(S, { name: "AA", animated: false });
    sevenTv.setEmotes("setA", "Main", ["a"]);
    await core.linkSourceSet(S, userLink);
    expect((await problems()).map((p) => p.kind)).toEqual(["renamed-with-suffix"]);
    sevenTv.setEmotes("setA", "Main", []);
    await core.reconcile(S);
    expect(await problems()).toEqual([]);
  });

  test("a suffix problem goes away when the Source Set explicitly adopts the current name", async () => {
    const { discord, sevenTv, core, emotes, names, problems } = setup();
    emotes(["a"]);
    discord.seedEmoji(S, { name: "AA", animated: false });
    sevenTv.setEmotes("setA", "Main", ["a"]);
    await core.linkSourceSet(S, userLink);
    expect(await problems()).toMatchObject([{ kind: "renamed-with-suffix" }]);
    sevenTv.renameEmote("a", "AA_2");
    const result = await core.reconcile(S);
    expect(result.changes).toEqual([]);
    expect(names()).toEqual(["AA", "AA_2"]);
    expect(await problems()).toEqual([]);
  });

  test("failed Trending Fill does not erase a pending victim from a previous Displacement", async () => {
    const { discord, sevenTv, core, emotes } = setup();
    emotes(["a", "b"]);
    for (let i = 0; i < 49; i++) discord.seedEmoji(S, { name: `reserved_${i}`, animated: false });
    sevenTv.setTrending("week", ["a"]);
    await core.apply(S, new SetTrendingCommand(true));
    discord.failCreatesAfter(S, 0, new Error("cannot upload"));
    await addRequestedEmote(core, S, "b");
    expect((await core.status(S)).problems).toMatchObject([{ kind: "pending", sevenTvEmoteId: "a" }]);

    const trending = spyOn(sevenTv, "getTrending").mockRejectedValueOnce(new Error("7TV outage"));
    try {
      await expect(core.reconcile(S)).rejects.toThrow("7TV outage");
      expect((await core.status(S)).problems).toMatchObject([{ kind: "pending", sevenTvEmoteId: "a" }]);
    } finally {
      trending.mockRestore();
    }
    discord.allowCreates(S);
    await core.reconcile(S);
    expect((await core.status(S)).problems).toEqual([]);
  });

  test("a problem about a removed Trending Fill emote goes away", async () => {
    const { sevenTv, core, emotes, problems } = setup();
    emotes(["big"]);
    sevenTv.setImageSize("big", TOO_BIG);
    sevenTv.setTrending("week", ["big"]);
    await core.apply(S, new SetTrendingCommand(true));
    expect(await problems()).toHaveLength(1);
    await core.apply(S, new SetTrendingCommand(false));
    expect(await problems()).toEqual([]);
  });
});

describe("Trending Fill and Source Set renames are no longer silent", () => {
  test("a too-large trending emote is reported once and not downloaded again", async () => {
    const { sevenTv, core, emotes, names, problems } = setup();
    emotes(["big", "b"]);
    sevenTv.setImageSize("big", TOO_BIG);
    sevenTv.setTrending("week", ["big", "b"]);
    const first = await core.apply(S, new SetTrendingCommand(true));
    expect(names()).toEqual(["BB"]);
    expect(warnings(first).some((f) => f.text.includes("BIGBIG"))).toBe(true);
    expect((await problems()).map((p) => p.kind)).toEqual(["too-large"]);

    const second = await core.reconcile(S);
    expect(warnings(second)).toEqual([]);
    expect(sevenTv.downloadCount("big")).toBe(1);
    expect((await problems()).map((p) => p.kind)).toEqual(["too-large"]);
  });

  test("an unavailable Trending Fill image stays skipped without another download", async () => {
    const { sevenTv, discord, core, emotes, problems } = setup();
    emotes(["a"]);
    sevenTv.disableDownload("a");
    sevenTv.setTrending("week", ["a"]);
    await core.apply(S, new SetTrendingCommand(true));
    const result = await core.reconcile(S);
    expect(warnings(result)).toEqual([]);
    expect(sevenTv.downloadCount("a")).toBe(1);
    for (let i = 0; i < 50; i++) discord.seedEmoji(S, { name: `hand${i}`, animated: false });
    await core.reconcile(S);
    expect((await problems()).map((p) => p.kind)).toEqual(["skipped"]);
  });

  test("Trending Fill retries a transient image problem without warning again or blocking other candidates", async () => {
    const { sevenTv, core, emotes, names, problems } = setup();
    emotes(["a", "b"]);
    sevenTv.setTrending("week", ["a", "b"]);
    const download = spyOn(sevenTv, "downloadImage");
    const unavailable = { ok: false, reason: "retryable" } as const;
    download.mockResolvedValueOnce(unavailable);
    const first = await core.apply(S, new SetTrendingCommand(true));
    expect(warnings(first)).toHaveLength(1);
    expect(names()).toEqual(["BB"]);
    expect(await problems()).toMatchObject([{ kind: "skipped", retryable: true }]);
    download.mockResolvedValueOnce(unavailable);
    expect(warnings(await core.reconcile(S))).toEqual([]);
    download.mockRestore();

    await core.reconcile(S);
    expect(names()).toEqual(["AA", "BB"]);
    expect(await problems()).toEqual([]);
  });

  test("a suffixed trending emote produces feedback and a problem", async () => {
    const { discord, sevenTv, core, emotes, names, problems } = setup();
    emotes(["a"]);
    discord.seedEmoji(S, { name: "AA", animated: false });
    sevenTv.setTrending("week", ["a"]);
    const r = await core.apply(S, new SetTrendingCommand(true));
    expect(names()).toEqual(["AA", "AA_2"]);
    expect(warnings(r).some((f) => f.text.includes("AA_2"))).toBe(true);
    expect((await problems()).map((p) => p.kind)).toEqual(["renamed-with-suffix"]);
  });

  test("a Source Set rename that collides produces feedback and a problem", async () => {
    const { discord, sevenTv, core, emotes, names, problems } = setup();
    emotes(["a"]);
    sevenTv.setEmotes("setA", "Main", ["a"]);
    await core.linkSourceSet(S, userLink);
    discord.seedEmoji(S, { name: "Zed", animated: false });
    sevenTv.renameEmote("a", "Zed");
    const r = await core.reconcile(S);
    expect(names()).toEqual(["Zed", "Zed_2"]);
    expect(warnings(r).some((f) => f.text.includes("Zed_2"))).toBe(true);
    expect((await problems()).map((p) => p.kind)).toEqual(["renamed-with-suffix"]);
  });
});

describe("removing a mirrored emote", () => {
  test("says a Source Set emote comes back unless removed from the 7TV set", async () => {
    const { sevenTv, core, emotes } = setup();
    emotes(["a"]);
    sevenTv.setEmotes("setA", "Main", ["a"]);
    await core.linkSourceSet(S, userLink);
    const r = await core.removeEmote(S, "AA");
    const text = r.feedback.map((f) => f.text).join(" ");
    expect(text).toContain("7TV set");
  });

  test("says a Trending Fill emote may be refilled", async () => {
    const { sevenTv, core, emotes } = setup();
    emotes(["t"]);
    sevenTv.setTrending("week", ["t"]);
    await core.apply(S, new SetTrendingCommand(true));
    const r = await core.removeEmote(S, "TT");
    expect(r.feedback.map((f) => f.text).join(" ")).toContain("Trending Fill");
  });

  test("warns when a removed Requested Emote is still in the active Source Set", async () => {
    const { sevenTv, core, emotes, names } = setup();
    emotes(["r"]);
    await addRequestedEmote(core, S, "r", "mine");
    sevenTv.setEmotes("setA", "Main", ["r"]);
    await core.linkSourceSet(S, userLink);
    const result = await core.removeEmote(S, "mine");
    expect(warnings(result).map((f) => f.text).join(" ")).toContain("Source Set");
    expect(names()).toEqual([]);
    await core.reconcile(S);
    expect(names()).toEqual(["RR"]);
  });

  test("a Requested Emote removal needs no warning", async () => {
    const { core, emotes } = setup();
    emotes(["r"]);
    await addRequestedEmote(core, S, "r");
    const r = await core.removeEmote(S, "RR");
    expect(r.feedback.map((f) => f.text)).toEqual(["Removed RR."]);
  });
});
