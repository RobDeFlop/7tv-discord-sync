import { expect, jest, test } from "bun:test";
import { FakeDiscord, FakeSevenTv, FakeStore } from "../testing/fakes.ts";
import { RateLimitError } from "../ports/index.ts";
import { SyncCore, type SyncUpdate } from "./index.ts";

test("sync retries keep partial writes, update joined observers, and do not block another Server", async () => {
  jest.useFakeTimers();
  const discord = new FakeDiscord();
  const sevenTv = new FakeSevenTv();
  const store = new FakeStore();
  const core = new SyncCore(sevenTv, discord, store);
  try {
    discord.addServer("a");
    discord.addServer("b");
    for (const id of ["e1", "e2"]) sevenTv.addEmote({ id, name: `Name_${id}`, animated: false });
    sevenTv.addUser({ id: "user", username: "streamer", activeSetId: "set" });
    sevenTv.setEmotes("set", "Set", ["e1", "e2"]);
    const state = await store.load("a");
    state.linkUser("user");
    await store.save("a", state);
    discord.failCreatesAfter("a", 1, new RateLimitError(2_000));

    const first: SyncUpdate[] = [];
    const second: SyncUpdate[] = [];
    const a = core.reconcile("a", async (_server, update) => { first.push(update); });
    await core.syncIdle();
    expect(first.map(({ kind }) => kind)).toEqual(["paused"]);
    expect(first[0]?.result.changes).toMatchObject([{ type: "created", sevenTvEmoteId: "e1" }]);
    expect((await store.load("a")).managedEmotes).toHaveLength(1);

    discord.seedEmoji("b", { name: "manual", animated: false });
    await core.reconcile("b");
    expect((await store.load("b")).toSnapshot().reservedSlots).toHaveLength(1);
    const joined = core.reconcile("a", async (_server, update) => { second.push(update); });
    await core.syncIdle();
    expect(second).toEqual(first);

    jest.advanceTimersByTime(2_000);
    await core.syncIdle();
    expect(first.map(({ kind }) => kind)).toEqual(["paused", "paused"]);
    expect(second).toEqual(first);
    discord.allowCreates("a");
    jest.advanceTimersByTime(3_999);
    await core.syncIdle();
    expect(discord.emojis("a")).toHaveLength(1);
    jest.advanceTimersByTime(1);
    const [result, joinedResult] = await Promise.all([a, joined]);
    await core.syncIdle();
    expect(result).toEqual(joinedResult);
    expect(result.changes).toMatchObject([
      { type: "created", sevenTvEmoteId: "e1" },
      { type: "created", sevenTvEmoteId: "e2" },
    ]);
    expect(first.map(({ kind }) => kind)).toEqual(["paused", "paused", "finished"]);
    expect(first).toEqual(second);
    expect(first.at(-1)?.result.feedback).toContainEqual({
      level: "info", text: "Sync resumed after Discord's rate limit.",
    });
  } finally {
    await core.stop();
    jest.useRealTimers();
  }
});
