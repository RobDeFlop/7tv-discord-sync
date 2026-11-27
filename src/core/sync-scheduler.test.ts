import { expect, jest, test } from "bun:test";
import { FakeDiscord, FakeSevenTv, FakeStore } from "../testing/fakes.ts";
import { RateLimitError } from "../ports/index.ts";
import { SyncCore, type SyncUpdate } from "./index.ts";
import type { ServerId } from "../domain/index.ts";
import { ServerLock } from "./server-lock.ts";
import { MAX_CONCURRENT_RECONCILES, SyncScheduler } from "./sync-scheduler.ts";

class ReservingLock extends ServerLock {
  public afterReserve?: () => void;

  public override tryRun<T>(server: ServerId, task: () => Promise<T>): Promise<T> | undefined {
    const reserved = super.tryRun(server, task);
    if (reserved) this.afterReserve?.();
    return reserved;
  }
}

test("cancellation between reserving the Server lock and starting an attempt skips Discord work", async () => {
  const lock = new ReservingLock();
  let attempts = 0;
  const scheduler = new SyncScheduler(lock, async () => { attempts++; }, () => {});
  lock.afterReserve = () => scheduler.cancel("left");
  const updates: SyncUpdate[] = [];
  await scheduler.request("left", async (_server, update) => { updates.push(update); });
  await scheduler.idle();
  expect(updates.map(({ kind }) => kind)).toEqual(["cancelled"]);
  expect(attempts).toBe(0);
});

test("coalesced result delivery is bounded separately from reconciliation", async () => {
  const discord = new FakeDiscord();
  discord.addServer("a");
  discord.addServer("b");
  const core = new SyncCore(new FakeSevenTv(), discord, new FakeStore());
  const release = Promise.withResolvers<void>();
  const full = Promise.withResolvers<void>();
  let active = 0;
  let delivered = 0;
  let peak = 0;
  const count = MAX_CONCURRENT_RECONCILES * 3;
  const requests = Array.from({ length: count }, () => core.reconcile("a", async () => {
    peak = Math.max(peak, ++active);
    if (active === MAX_CONCURRENT_RECONCILES) full.resolve();
    await release.promise;
    active--;
    delivered++;
  }));
  try {
    await full.promise;
    await Bun.sleep(0);
    expect(active).toBe(MAX_CONCURRENT_RECONCILES);
    discord.seedEmoji("b", { name: "manual", animated: false });
    await core.reconcile("b");
    expect((await core.status("b")).quotas.static.byTier.reserved).toBe(1);
  } finally {
    release.resolve();
    await Promise.all(requests);
    await core.stop();
  }
  expect(delivered).toBe(count);
  expect(peak).toBe(MAX_CONCURRENT_RECONCILES);
});

test("a rate-limited Requested Emote preserves its displacement and queues recovery", async () => {
  jest.useFakeTimers();
  const discord = new FakeDiscord();
  const sevenTv = new FakeSevenTv();
  const store = new FakeStore();
  const core = new SyncCore(sevenTv, discord, store);
  try {
    const server = "a";
    discord.addServer(server);
    for (let i = 0; i < 49; i++) discord.seedEmoji(server, { name: `manual_${i}`, animated: false });
    sevenTv.addEmote({ id: "source", name: "Mirror", animated: false });
    sevenTv.addEmote({ id: "request", name: "Request", animated: false });
    sevenTv.addUser({ id: "user", username: "streamer", activeSetId: "set" });
    sevenTv.setEmotes("set", "Set", ["source"]);
    await core.linkSourceSet(server, "https://7tv.app/users/user");
    const preview = await core.prepareEmoteAdd(server, "https://7tv.app/emotes/request");
    if (!("prepared" in preview)) throw new Error("Expected an importable preview");
    discord.failCreatesAfter(server, 0, new RateLimitError(2_000));

    const result = await core.addEmote(server, preview.prepared);
    expect(result.feedback).toContainEqual({ level: "warning", text: expect.stringContaining("rate limit") });
    expect(result.feedback).not.toContainEqual({ level: "error", text: expect.any(String) });
    expect(result.changes).toEqual([{ type: "deleted", name: "Mirror", reason: "displaced" }]);
    const saved = (await store.load(server)).toSnapshot();
    expect(saved.problems).toContainEqual(expect.objectContaining({ kind: "pending", sevenTvEmoteId: "source" }));
    expect(saved.managedEmotes).toEqual([]);
    expect(saved.requestedEmotes).toEqual([]);
    expect((await core.status(server)).lastSync?.retryAt).toBeGreaterThanOrEqual(Date.now());
  } finally {
    await core.stop();
    jest.useRealTimers();
  }
});

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
