import { describe, expect, test } from "bun:test";
import { AddEmoteCommand, LinkSourceSetCommand, SetTrendingCommand, SyncCore } from "./index.ts";
import { FakeDiscord, FakeSevenTv, FakeStore } from "../testing/fakes.ts";

const S = "server-1";
const link = (id: string) => `https://7tv.app/emotes/${id}`;

function setup(boostLevel: number) {
  const discord = new FakeDiscord();
  discord.addServer(S, { boostLevel });
  const sevenTv = new FakeSevenTv();
  const core = new SyncCore(sevenTv, discord, new FakeStore());
  sevenTv.addUser({ id: "u1", username: "streamer", activeSetId: "setA" });
  /** Register `count` static emotes named `<prefix>0..`; returns their ids. */
  const emotes = (prefix: string, count: number, animated = false): string[] => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `${prefix}${i}`;
      sevenTv.addEmote({ id, name: `${prefix}${i}`, animated });
      ids.push(id);
    }
    return ids;
  };
  const named = (prefix: string) => discord.emojis(S).filter((e) => e.name.startsWith(prefix)).length;
  const hand = (count: number, animated = false) => {
    for (let i = 0; i < count; i++) discord.seedEmoji(S, { name: `hand${animated ? "a" : "s"}${i}`, animated });
  };
  return { discord, sevenTv, core, emotes, named, hand };
}

describe("boost level drops", () => {
  test("removes Trending Fill first, then the Source Set tail; Reserved Slots stay; admin is told", async () => {
    const { discord, sevenTv, core, emotes, named, hand } = setup(1); // 100 static
    hand(20);
    const source = emotes("src", 40);
    sevenTv.setEmotes("setA", "A", source);
    const trending = emotes("trd", 40);
    sevenTv.setTrending("week", trending);
    await core.apply(S, new LinkSourceSetCommand(`https://7tv.app/users/u1`));
    await core.apply(S, new SetTrendingCommand(true));
    expect(discord.emojis(S)).toHaveLength(100);

    discord.setBoostLevel(S, 0); // 50 static
    const r = await core.reconcile(S);

    expect(discord.emojis(S)).toHaveLength(50);
    expect(named("hand")).toBe(20);
    expect(named("trd")).toBe(0);
    expect(named("src")).toBe(30);
    // the last Source Set emotes are the ones that go
    expect(discord.emojis(S).some((e) => e.name === "src39")).toBe(false);
    expect(discord.emojis(S).some((e) => e.name === "src0")).toBe(true);
    expect(r.feedback.some((f) => f.level === "warning" && /boost/i.test(f.text))).toBe(true);
    expect(r.changes.filter((c) => c.type === "deleted")).toHaveLength(50);
  });

  test("Requested Emotes go only when nothing of lower Precedence is left; Reserved Slots never", async () => {
    const { discord, sevenTv, core, emotes, named, hand } = setup(1);
    hand(30);
    for (const id of emotes("req", 30)) await core.apply(S, new AddEmoteCommand(link(id)));
    const source = emotes("src", 40);
    sevenTv.setEmotes("setA", "A", source);
    await core.apply(S, new LinkSourceSetCommand(`https://7tv.app/users/u1`));
    expect(discord.emojis(S)).toHaveLength(100);

    discord.setBoostLevel(S, 0); // 50 static: 30 reserved + 20 left for 30 requested + 40 source
    await core.reconcile(S);
    expect(named("hand")).toBe(30);
    expect(named("src")).toBe(0);
    expect(named("req")).toBe(20);
    expect(discord.emojis(S)).toHaveLength(50);
  });
});

describe("boost level rises", () => {
  test("pending Source Set emotes fill the new slots before Trending Fill", async () => {
    const { discord, sevenTv, core, emotes, named, hand } = setup(0);
    hand(30);
    sevenTv.setEmotes("setA", "A", emotes("src", 40));
    sevenTv.setTrending("week", emotes("trd", 100));
    await core.apply(S, new LinkSourceSetCommand(`https://7tv.app/users/u1`));
    await core.apply(S, new SetTrendingCommand(true));
    expect(named("src")).toBe(20);
    expect((await core.status(S)).problems.filter((p) => p.kind === "pending")).toHaveLength(20);

    discord.setBoostLevel(S, 1); // 100 static
    await core.reconcile(S);
    expect(named("src")).toBe(40);
    expect(named("trd")).toBe(30);
    expect(discord.emojis(S)).toHaveLength(100);
    expect((await core.status(S)).problems.filter((p) => p.kind === "pending")).toHaveLength(0);
  });
});

describe("catch-up reconcile", () => {
  test("converges after the set changed, emojis were hand-added and hand-deleted, and boost changed", async () => {
    const { discord, sevenTv, core, emotes, named } = setup(0);
    const ids = emotes("src", 10);
    sevenTv.setEmotes("setA", "A", ids.slice(0, 5));
    await core.apply(S, new LinkSourceSetCommand(`https://7tv.app/users/u1`));
    expect(named("src")).toBe(5);

    // while the bot was down:
    sevenTv.setEmotes("setA", "A", ids.slice(3, 8)); // src0-2 left, src5-7 joined
    sevenTv.renameEmote("src3", "Renamed3");
    const gone = discord.emojis(S).find((e) => e.name === "src4")!;
    discord.removeEmojiByHand(S, gone.id);
    discord.seedEmoji(S, { name: "handmade", animated: false });
    discord.setBoostLevel(S, 1);

    await core.reconcile(S);
    expect(discord.emojis(S).map((e) => e.name).sort()).toEqual(
      ["Renamed3", "handmade", "src4", "src5", "src6", "src7"].sort(),
    );
    const st = await core.status(S);
    expect(st.quotas.static.byTier).toMatchObject({ reserved: 1, source: 5 });

    // converged: another reconcile changes nothing
    const again = await core.reconcile(S);
    expect(again.changes).toEqual([]);
  });
});

describe("missing Manage Expressions", () => {
  test("reconcile reports it as feedback instead of crashing", async () => {
    const { discord, sevenTv, core, emotes } = setup(0);
    sevenTv.setEmotes("setA", "A", emotes("src", 3));
    await core.apply(S, new LinkSourceSetCommand(`https://7tv.app/users/u1`));
    discord.revokeManageExpressions(S);
    sevenTv.setEmotes("setA", "A", emotes("src", 5));
    const r = await core.reconcile(S);
    expect(r.feedback.some((f) => f.level === "error" && /Manage Expressions/.test(f.text))).toBe(true);
    expect(discord.emojis(S)).toHaveLength(3);
  });

  test("a command reports it as feedback too", async () => {
    const { discord, sevenTv, core } = setup(0);
    sevenTv.addEmote({ id: "e1", name: "Pog", animated: false });
    discord.revokeManageExpressions(S);
    const r = await core.apply(S, new AddEmoteCommand(link("e1")));
    expect(r.feedback.some((f) => f.level === "error" && /Manage Expressions/.test(f.text))).toBe(true);
  });
});
