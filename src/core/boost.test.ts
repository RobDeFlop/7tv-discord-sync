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
});
