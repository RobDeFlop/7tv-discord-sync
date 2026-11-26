import { describe, expect, test } from "bun:test";
import { AddEmoteCommand, LinkSourceSetCommand, SetTrendingCommand, SyncCore } from "./index.ts";
import { FakeDiscord, FakeSevenTv, FakeStore } from "../testing/fakes.ts";

const S = "server-1";
const emoteLink = (id: string) => `https://7tv.app/emotes/${id}`;

function setup() {
  const discord = new FakeDiscord();
  discord.addServer(S, { boostLevel: 0 }); // 50 static + 50 animated
  const sevenTv = new FakeSevenTv();
  const core = new SyncCore(sevenTv, discord, new FakeStore());
  sevenTv.addUser({ id: "u1", username: "streamer", activeSetId: "setA" });
  const emotes = (ids: string[], animated = false) => {
    for (const id of ids) sevenTv.addEmote({ id, name: id.toUpperCase().repeat(2), animated });
  };
  const names = (animated?: boolean) =>
    discord
      .emojis(S)
      .filter((e) => animated === undefined || e.animated === animated)
      .map((e) => e.name)
      .sort();
  /** Fill a quota with hand-made emojis until `free` slots remain. */
  const fillByHand = (animated: boolean, free: number) => {
    const have = discord.emojis(S).filter((e) => e.animated === animated).length;
    for (let i = have; i < 50 - free; i++) discord.seedEmoji(S, { name: `hand${animated ? "a" : "s"}${i}`, animated });
  };
  return { discord, sevenTv, core, emotes, names, fillByHand };
}

const errors = (r: { feedback: { level: string; text: string }[] }) => r.feedback.filter((f) => f.level === "error");

describe("Trending Fill", () => {
  test("turning it on fills free slots from the weekly trending list, in order", async () => {
    const { sevenTv, core, emotes, names, fillByHand } = setup();
    emotes(["a", "b", "c"]);
    sevenTv.setTrending("week", ["a", "b", "c"]);
    fillByHand(false, 2);
    const r = await core.apply(S, new SetTrendingCommand(true));
    expect(errors(r)).toEqual([]);
    expect(names(false).filter((n) => !n.startsWith("hand"))).toEqual(["AA", "BB"]);
    const st = await core.status(S);
    expect(st.trending).toEqual({ enabled: true, period: "week" });
    expect(st.quotas.static.byTier.trending).toBe(2);
  });

  test("uses the chosen period and remembers it", async () => {
    const { sevenTv, core, emotes, names } = setup();
    emotes(["a", "m"]);
    sevenTv.setTrending("week", ["a"]);
    sevenTv.setTrending("month", ["m"]);
    await core.apply(S, new SetTrendingCommand(true, "month"));
    expect(names()).toEqual(["MM"]);
    expect((await core.status(S)).trending.period).toBe("month");
  });

  test("keeps static and animated quotas separate and does not filter by animated", async () => {
    const { sevenTv, core, emotes, names, fillByHand } = setup();
    emotes(["a", "b"]);
    emotes(["x", "y"], true);
    sevenTv.setTrending("week", ["a", "x", "b", "y"]);
    fillByHand(false, 1); // one static slot
    fillByHand(true, 2); // two animated slots
    await core.apply(S, new SetTrendingCommand(true));
    const added = (animated: boolean) => names(animated).filter((n) => !n.startsWith("hand"));
    expect(added(false)).toEqual(["AA"]);
    expect(added(true)).toEqual(["XX", "YY"]);
  });

  test("never displaces anything when quotas are full", async () => {
    const { sevenTv, core, emotes, names, fillByHand } = setup();
    emotes(["a", "b"]);
    sevenTv.setTrending("week", ["a", "b"]);
    fillByHand(false, 0);
    const before = names();
    await core.apply(S, new SetTrendingCommand(true));
    expect(names()).toEqual(before);
  });

  test("Source Set and Requested Emotes displace Trending Fill, never the reverse", async () => {
    const { sevenTv, core, emotes, names, fillByHand } = setup();
    emotes(["t1", "t2", "s1", "r1"]);
    sevenTv.setTrending("week", ["t1", "t2"]);
    sevenTv.setEmotes("setA", "Main", ["s1"]);
    fillByHand(false, 2);
    await core.apply(S, new SetTrendingCommand(true));
    expect((await core.status(S)).quotas.static.byTier.trending).toBe(2);

    await core.apply(S, new LinkSourceSetCommand("https://7tv.app/users/u1"));
    let st = await core.status(S);
    expect(st.quotas.static.byTier).toMatchObject({ source: 1, trending: 1 });

    await core.apply(S, new AddEmoteCommand(emoteLink("r1")));
    st = await core.status(S);
    expect(st.quotas.static.byTier).toMatchObject({ requested: 1, source: 1, trending: 0 });

    await core.reconcile(S); // trending must not take anything back
    expect(names().filter((n) => !n.startsWith("hand"))).toEqual(["R1R1", "S1S1"]);
  });

  test("an emote already managed at a higher tier is not added again", async () => {
    const { sevenTv, core, emotes, names } = setup();
    emotes(["a", "b"]);
    sevenTv.setEmotes("setA", "Main", ["a"]);
    sevenTv.setTrending("week", ["a", "b"]);
    await core.apply(S, new LinkSourceSetCommand("https://7tv.app/users/u1"));
    await core.apply(S, new SetTrendingCommand(true));
    expect(names()).toEqual(["AA", "BB"]);
    expect((await core.status(S)).quotas.static.byTier).toMatchObject({ source: 1, trending: 1 });
  });

  test("turning it off removes every Trending Fill emote and nothing else", async () => {
    const { sevenTv, core, emotes, names } = setup();
    emotes(["a", "b", "t"]);
    sevenTv.setEmotes("setA", "Main", ["a"]);
    sevenTv.setTrending("week", ["t", "b"]);
    await core.apply(S, new LinkSourceSetCommand("https://7tv.app/users/u1"));
    await core.apply(S, new SetTrendingCommand(true));
    expect(names()).toEqual(["AA", "BB", "TT"]);
    const r = await core.apply(S, new SetTrendingCommand(false));
    expect(names()).toEqual(["AA"]);
    expect(r.changes.filter((c) => c.type === "deleted" && c.reason === "trending-off")).toHaveLength(2);
    expect((await core.status(S)).trending.enabled).toBe(false);
  });

  test("skips trending emotes whose image cannot be used", async () => {
    const { sevenTv, core, emotes, names } = setup();
    emotes(["a", "b"]);
    sevenTv.setImageSize("a", 10 * 1024 * 1024);
    sevenTv.setTrending("week", ["a", "b"]);
    await core.apply(S, new SetTrendingCommand(true));
    expect(names()).toEqual(["BB"]);
  });
});
