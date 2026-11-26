import { describe, expect, test } from "bun:test";
import { LinkSourceSetCommand, SetTrendingCommand, SyncCore } from "./index.ts";
import { FakeDiscord, FakeSevenTv, FakeStore } from "../testing/fakes.ts";

const S = "server-1";
const userLink = (id: string) => `https://7tv.app/users/${id}`;

function setup() {
  const discord = new FakeDiscord();
  discord.addServer(S, { boostLevel: 0 });
  const sevenTv = new FakeSevenTv();
  const core = new SyncCore(sevenTv, discord, new FakeStore());
  sevenTv.addUser({ id: "u1", username: "streamer", activeSetId: "setA" });
  const emotes = (ids: string[]) => {
    for (const id of ids) sevenTv.addEmote({ id, name: id.toUpperCase().repeat(2), animated: false });
  };
  return { discord, sevenTv, core, emotes };
}

describe("Trending Fill", () => {
  test("looks up the slot limits once per reconcile, not once per candidate", async () => {
    const { discord, sevenTv, core, emotes } = setup();
    emotes(["a", "b", "c", "d", "e"]);
    sevenTv.setTrending("week", ["a", "b", "c", "d", "e"]);
    await core.reconcile(S);
    const before = discord.quotaLookups;
    await core.apply(S, new SetTrendingCommand(true));
    expect(discord.quotaLookups - before).toBe(1);
  });
});

describe("Manage Expressions permission", () => {
  test("reconcile reports a missing permission up front, even when nothing needs writing", async () => {
    const { discord, core } = setup();
    discord.revokeManageExpressions(S);
    const r = await core.reconcile(S);
    expect(r.feedback.filter((f) => f.level === "error").map((f) => f.text.includes("Manage Expressions"))).toEqual([true]);
  });

  test("reconcile attempts no writes without the permission", async () => {
    const { discord, sevenTv, core, emotes } = setup();
    emotes(["a"]);
    sevenTv.setEmotes("setA", "Main", ["a"]);
    discord.revokeManageExpressions(S);
    const r = await core.apply(S, new LinkSourceSetCommand(userLink("u1")));
    expect(r.feedback.filter((f) => f.level === "error")).toHaveLength(1);
    expect(discord.emojis(S)).toEqual([]);
  });

  test("/status shows whether the permission is missing", async () => {
    const { discord, core } = setup();
    expect((await core.status(S)).manageExpressions).toBe(true);
    discord.revokeManageExpressions(S);
    expect((await core.status(S)).manageExpressions).toBe(false);
  });
});

describe("state survives unexpected errors", () => {
  test("emojis created before a failing write stay Managed, not Reserved", async () => {
    const { discord, sevenTv, core, emotes } = setup();
    emotes(["a", "b", "c"]);
    sevenTv.setEmotes("setA", "Main", ["a", "b", "c"]);
    discord.failCreatesAfter(S, 2, new Error("boom"));
    await expect(core.apply(S, new LinkSourceSetCommand(userLink("u1")))).rejects.toThrow("boom");

    const status = await core.status(S);
    expect(status.quotas.static.byTier).toMatchObject({ source: 2, reserved: 0 });
  });

  test("a failing 7TV call mid-reconcile keeps what was already applied", async () => {
    const { discord, sevenTv, core, emotes } = setup();
    emotes(["a"]);
    sevenTv.setEmotes("setA", "Main", ["a"]);
    await core.apply(S, new LinkSourceSetCommand(userLink("u1")));
    emotes(["b"]);
    sevenTv.setEmotes("setA", "Main", ["a", "b"]);
    discord.failCreatesAfter(S, 0, new Error("down"));
    await expect(core.reconcile(S)).rejects.toThrow("down");
    expect((await core.status(S)).quotas.static.byTier).toMatchObject({ source: 1, reserved: 0 });
  });
});
