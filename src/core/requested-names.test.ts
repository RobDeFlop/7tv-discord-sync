import { describe, expect, test } from "bun:test";
import { SyncCore } from "./index.ts";
import { FakeDiscord, FakeSevenTv, FakeStore, MAX_EMOJI_BYTES } from "../testing/fakes.ts";
import { prepareRequestedEmote } from "../testing/requested-emotes.ts";

const S = "server-1";
const userLink = "https://7tv.app/users/u1";

function setup() {
  const discord = new FakeDiscord();
  discord.addServer(S, { boostLevel: 0 });
  const sevenTv = new FakeSevenTv();
  const store = new FakeStore();
  const core = new SyncCore(sevenTv, discord, store);
  sevenTv.addUser({ id: "u1", username: "streamer", activeSetId: "setA" });
  sevenTv.addEmote({ id: "a", name: "AA", animated: false });
  sevenTv.addEmote({ id: "b", name: "BB", animated: false });
  sevenTv.setEmotes("setA", "Main", ["a"]);
  const names = () => discord.emojis(S).map((e) => e.name).sort();
  const prepare = (id = "a") => prepareRequestedEmote(core, S, id);
  const fill = (count: number) => {
    for (let i = 0; i < count; i++) discord.seedEmoji(S, { name: `hand${i}`, animated: false });
  };
  return { discord, sevenTv, store, core, names, prepare, fill };
}

describe("Requested Emote preparation and confirmation", () => {
  test("adds the exact name and bytes previously shown without writing during preview", async () => {
    const { core, discord, names, prepare, sevenTv, store } = setup();
    sevenTv.renameEmote("a", "Cat Face");
    const { prepared, previewImage } = await prepare();
    expect(prepared.defaultName).toBe("Cat_Face");
    expect(await store.listServers()).toEqual([]);
    expect(names()).toEqual([]);
    sevenTv.renameEmote("a", "Changed");
    expect((await core.addEmote(S, prepared)).feedback).toEqual([{ level: "info", text: "Added Cat_Face." }]);
    expect(sevenTv.downloadCount("a")).toBe(1);
    const [emoji] = discord.emojis(S);
    expect(emoji && discord.emojiImageSnapshot(emoji.id)).toEqual(previewImage);
    expect((await store.load(S)).requestedEmotes).toEqual([{ sevenTvEmoteId: "a", requestedName: "Cat_Face" }]);
  });

  test("an approved suffixed default warns once and stays current while managed", async () => {
    const { core, discord, prepare } = setup();
    discord.seedEmoji(S, { name: "AA", animated: false });
    const { prepared } = await prepare();
    expect(prepared.defaultName).toBe("AA_2");
    expect((await core.addEmote(S, prepared)).feedback.filter(({ level }) => level === "warning")).toHaveLength(1);
    expect((await core.addEmote(S, (await prepare()).prepared)).feedback.filter(({ level }) => level === "warning")).toEqual([]);
    await core.reconcile(S);
    expect((await core.status(S)).problems).toMatchObject([{ kind: "renamed-with-suffix", sevenTvEmoteId: "a" }]);
    await core.removeEmote(S, "AA_2");
    await core.reconcile(S);
    expect((await core.status(S)).problems).toEqual([]);
  });

  test("the preview's name and Displacement plan agree even when the victim owns the name", async () => {
    const { core, sevenTv, fill, names, prepare } = setup();
    fill(49);
    await core.linkSourceSet(S, userLink);
    sevenTv.renameEmote("b", "AA");
    const { prepared, slotNotice } = await prepare("b");
    expect(prepared.defaultName).toBe("AA");
    expect(slotNotice).toContain("Managed Emote (AA)");
    const result = await core.addEmote(S, prepared);
    expect(result.changes).toEqual([
      { type: "deleted", name: "AA", reason: "displaced" },
      { type: "created", name: "AA", sevenTvEmoteId: "b", tier: "requested", animated: false },
    ]);
    expect(names()).toHaveLength(50);
  });

  test("a newly required Displacement cannot delete an emoji the admin did not see", async () => {
    const { core, discord, fill, names, prepare } = setup();
    fill(48);
    await core.linkSourceSet(S, userLink);
    const { prepared, slotNotice } = await prepare("b");
    expect(slotNotice).toBeUndefined();
    discord.seedEmoji(S, { name: "held", animated: false });
    expect((await core.addEmote(S, prepared)).feedback[0]).toMatchObject({ reason: "emote-slot-changed" });
    expect(names()).toContain("AA");
    expect(names()).not.toContain("BB");
  });

  test("a full quota with no possible Displacement previews the condition and confirms without a write", async () => {
    const { core, fill, prepare, names } = setup();
    fill(50);
    const { prepared, slotNotice } = await prepare();
    expect(slotNotice).toContain("No Managed Emote is eligible for displacement");
    const result = await core.addEmote(S, prepared);
    expect(result.feedback[0]?.text).toContain("No free static slot");
    expect(result.changes).toEqual([]);
    expect(names()).toHaveLength(50);
  });

  test("an over-quota Server cannot place an emote by displacing only one victim", async () => {
    const { core, discord, fill, prepare } = setup();
    fill(49);
    await core.linkSourceSet(S, userLink);
    discord.seedEmoji(S, { name: "held", animated: false });
    const before = discord.emojis(S);
    const { prepared, slotNotice } = await prepare("b");
    expect(slotNotice).toContain("No Managed Emote is eligible for displacement");
    const result = await core.addEmote(S, prepared);
    expect(result.feedback[0]?.text).toContain("No free static slot");
    expect(result.changes).toEqual([]);
    expect(discord.emojis(S)).toEqual(before);
  });

  test("a name taken by an overlapping confirmation fails under the Server lock", async () => {
    const { core, names, prepare } = setup();
    const [first, second] = await Promise.all([prepare(), prepare("b")]);
    const outcomes = await Promise.all([core.addEmote(S, first.prepared, "Same"), core.addEmote(S, second.prepared, "same")]);
    expect(outcomes.flatMap(({ changes }) => changes)).toHaveLength(1);
    const errors = outcomes.flatMap(({ feedback }) => feedback).filter(({ level }) => level === "error");
    expect(errors).toMatchObject([{ reason: "emote-name-taken", retry: "and choose another name." }]);
    expect(names()).toHaveLength(1);
  });

  test("a name changed on an existing Managed Emote must be reviewed again", async () => {
    const { core, discord, prepare, store } = setup();
    await core.linkSourceSet(S, userLink);
    const { prepared } = await prepare();
    const [existing] = discord.emojis(S);
    if (!existing) throw new Error("Expected a Source Set emoji");
    await discord.renameEmoji(S, existing.id, "Changed");
    expect((await core.addEmote(S, prepared)).feedback[0]).toMatchObject({ reason: "emote-name-changed", retry: "to review the name." });
    expect((await store.load(S)).findManaged("a")?.tier).toBe("source");
  });

  test("a promotion rechecks a custom name and never chooses a suffix on conflict", async () => {
    const { core, discord, names, prepare, store } = setup();
    await core.linkSourceSet(S, userLink);
    const { prepared } = await prepare();
    discord.seedEmoji(S, { name: "Wave", animated: false });
    expect((await core.addEmote(S, prepared, "Wave")).feedback[0]?.reason).toBe("emote-name-taken");
    expect((await store.load(S)).findManaged("a")?.tier).toBe("source");
    const result = await core.addEmote(S, prepared, "Ocean");
    expect(names()).toEqual(["Ocean", "Wave"]);
    expect(result.changes).toContainEqual({ type: "renamed", from: "AA", to: "Ocean" });
    expect((await store.load(S)).findManaged("a")?.tier).toBe("requested");
  });

  test("an unavailable 7TV image falls back to the existing Discord emoji and promotes it in place", async () => {
    const { core, discord, prepare, sevenTv, store } = setup();
    await core.linkSourceSet(S, userLink);
    const [existing] = discord.emojis(S);
    if (!existing) throw new Error("Expected a Source Set emoji");
    sevenTv.disableDownload("a");
    const { prepared, previewImage } = await prepare();
    expect(discord.emojiImageSnapshot(existing.id)).toEqual(previewImage);
    const result = await core.addEmote(S, prepared);
    expect(result.feedback[0]?.text).toBe("AA is now a Requested Emote.");
    expect(discord.emojis(S)).toEqual([existing]);
    expect((await store.load(S)).findManaged("a")?.discordEmojiId).toBe(existing.id);
  });

  test("a fallback preview cannot promote a different Discord emoji with the same name", async () => {
    const { core, discord, prepare, sevenTv, store } = setup();
    await core.linkSourceSet(S, userLink);
    const [existing] = discord.emojis(S);
    if (!existing) throw new Error("Expected a Source Set emoji");
    sevenTv.setImageSize("a", MAX_EMOJI_BYTES + 1);
    const { prepared } = await prepare();
    discord.removeEmojiByHand(S, existing.id);
    sevenTv.setImageSize("a", 1024);
    await core.reconcile(S);
    const [replacement] = discord.emojis(S);
    expect(replacement?.id).not.toBe(existing.id);
    const result = await core.addEmote(S, prepared, "Wave");
    expect(result.changes).toEqual([]);
    expect(result.feedback[0]?.reason).toBe("emote-promotion-unavailable");
    expect((await store.load(S)).findManaged("a")?.tier).toBe("source");
  });

  test("a prepared upload can still be placed if the existing emoji goes away", async () => {
    const { core, discord, prepare, sevenTv } = setup();
    await core.linkSourceSet(S, userLink);
    const [existing] = discord.emojis(S);
    if (!existing) throw new Error("Expected a Source Set emoji");
    await discord.renameEmoji(S, existing.id, "MirrorName");
    const { prepared, previewImage } = await prepare();
    discord.removeEmojiByHand(S, existing.id);
    sevenTv.disableDownload("a");
    expect((await core.addEmote(S, prepared)).feedback[0]?.text).toBe("Added MirrorName.");
    const [created] = discord.emojis(S);
    expect(created?.id).not.toBe(existing.id);
    expect(created && discord.emojiImageSnapshot(created.id)).toEqual(previewImage);
  });

  test("an upload failure persists the displaced victim as pending until reconciliation restores it", async () => {
    const { core, discord, fill, names, prepare } = setup();
    fill(49);
    await core.linkSourceSet(S, userLink);
    const { prepared } = await prepare("b");
    discord.failCreatesAfter(S, 0, new Error("upload failed"));
    expect((await core.addEmote(S, prepared)).feedback.filter(({ level }) => level === "error")[0]?.text).toMatch(/AA.*next sync/);
    expect((await core.status(S)).problems).toMatchObject([{ kind: "pending", sevenTvEmoteId: "a" }]);
    discord.allowCreates(S);
    await core.reconcile(S);
    expect(names()).toContain("AA");
    expect((await core.status(S)).problems).toEqual([]);
  });
});
