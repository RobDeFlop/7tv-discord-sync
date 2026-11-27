import { describe, expect, spyOn, test } from "bun:test";
import { ConfigureLogChannelCommand, SetTrendingCommand, SyncCore, UnlinkSourceSetCommand } from "./index.ts";
import { FakeDiscord, FakeSevenTv, FakeStore } from "../testing/fakes.ts";

const S = "server-1";
const userLink = (id: string) => `https://7tv.app/users/${id}`;

function setup() {
  const discord = new FakeDiscord();
  discord.addServer(S, { boostLevel: 0 });
  const sevenTv = new FakeSevenTv();
  const store = new FakeStore();
  const core = new SyncCore(sevenTv, discord, store);
  sevenTv.addUser({ id: "u1", username: "streamer", activeSetId: "setA" });
  const emotes = (ids: string[]) => {
    for (const id of ids) sevenTv.addEmote({ id, name: id.toUpperCase().repeat(2), animated: false });
  };
  return { discord, sevenTv, store, core, emotes };
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
    const r = await core.linkSourceSet(S, userLink("u1"));
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
    await expect(core.linkSourceSet(S, userLink("u1"))).rejects.toThrow("boom");

    const status = await core.status(S);
    expect(status.quotas.static.byTier).toMatchObject({ source: 2, reserved: 0 });
  });

  test("Trending Fill persists Managed Emotes created before an upload fails", async () => {
    const { discord, sevenTv, core, emotes } = setup();
    emotes(["a", "b"]);
    sevenTv.setTrending("week", ["a", "b"]);
    discord.failCreatesAfter(S, 1, new Error("upload failed"));
    await expect(core.apply(S, new SetTrendingCommand(true))).rejects.toThrow("upload failed");
    expect((await core.status(S)).quotas.static.byTier).toMatchObject({ trending: 1, reserved: 0 });
  });

  test("unlink persists successful deletes before a later delete fails", async () => {
    const { discord, sevenTv, store, core, emotes } = setup();
    emotes(["a", "b"]);
    sevenTv.setEmotes("setA", "Main", ["a", "b"]);
    await core.linkSourceSet(S, userLink("u1"));
    const deleteEmoji = discord.deleteEmoji.bind(discord);
    const deletion = spyOn(discord, "deleteEmoji")
      .mockImplementationOnce(deleteEmoji)
      .mockRejectedValueOnce(new Error("delete failed"));
    await expect(core.apply(S, new UnlinkSourceSetCommand(false))).rejects.toThrow("delete failed");
    deletion.mockRestore();
    expect((await store.load(S)).toSnapshot()).toMatchObject({
      linkedUserId: "u1",
      managedEmotes: [expect.objectContaining({ sevenTvEmoteId: "b", tier: "source" })],
    });
  });

  test("remove persists ownership sync even when the Discord delete fails", async () => {
    const { discord, sevenTv, store, core, emotes } = setup();
    emotes(["a", "b"]);
    sevenTv.setEmotes("setA", "Main", ["a", "b"]);
    await core.linkSourceSet(S, userLink("u1"));
    const departed = discord.emojis(S).find((emoji) => emoji.name === "BB");
    if (!departed) throw new Error("Expected a second Managed Emote");
    discord.removeEmojiByHand(S, departed.id);
    const reserved = discord.seedEmoji(S, { name: "admin", animated: false });
    const deletion = spyOn(discord, "deleteEmoji").mockRejectedValueOnce(new Error("delete failed"));
    await expect(core.removeEmote(S, "AA")).rejects.toThrow("delete failed");
    deletion.mockRestore();
    expect((await store.load(S)).toSnapshot()).toMatchObject({
      managedEmotes: [expect.objectContaining({ sevenTvEmoteId: "a", tier: "source" })],
      reservedSlots: [expect.objectContaining({ discordEmojiId: reserved.id })],
    });
  });

  test("configure log channel persists ownership without reclassifying Managed Emotes", async () => {
    const { discord, sevenTv, store, core, emotes } = setup();
    emotes(["a"]);
    sevenTv.setEmotes("setA", "Main", ["a"]);
    await core.linkSourceSet(S, userLink("u1"));
    const reserved = discord.seedEmoji(S, { name: "admin", animated: false });
    await core.apply(S, new ConfigureLogChannelCommand("log"));
    expect((await store.load(S)).toSnapshot()).toMatchObject({
      logChannelId: "log",
      managedEmotes: [expect.objectContaining({ sevenTvEmoteId: "a", tier: "source" })],
      reservedSlots: [expect.objectContaining({ discordEmojiId: reserved.id })],
    });
  });

  test("a failing Discord call mid-reconcile keeps what was already applied", async () => {
    const { discord, sevenTv, core, emotes } = setup();
    emotes(["a"]);
    sevenTv.setEmotes("setA", "Main", ["a"]);
    await core.linkSourceSet(S, userLink("u1"));
    emotes(["b"]);
    sevenTv.setEmotes("setA", "Main", ["a", "b"]);
    discord.failCreatesAfter(S, 0, new Error("down"));
    await expect(core.reconcile(S)).rejects.toThrow("down");
    expect((await core.status(S)).quotas.static.byTier).toMatchObject({ source: 1, reserved: 0 });
  });
});
