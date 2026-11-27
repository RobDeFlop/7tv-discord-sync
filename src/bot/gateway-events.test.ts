import { describe, expect, jest, spyOn, test } from "bun:test";
import { RateLimitError } from "../adapters/discord/write-queue.ts";
import { ConfigureLogChannelCommand, SyncCore } from "../core/index.ts";
import { MAX_CONCURRENT_RECONCILES } from "../core/sync-scheduler.ts";
import type { ServerId } from "../domain/index.ts";
import { FakeDiscord, FakeSevenTv, FakeStore } from "../testing/fakes.ts";
import { FeedbackRouter } from "./feedback-router.ts";
import { GatewayEvents } from "./gateway-events.ts";
import { Logger, LogLevel } from "./logger.ts";
import { FakeLogChannel, FakeServers } from "../testing/bot-fakes.ts";

const A = "server-a";
const B = "server-b";

function setup() {
  const discord = new FakeDiscord();
  const sevenTv = new FakeSevenTv();
  const store = new FakeStore();
  const core = new SyncCore(sevenTv, discord, store, (server, operation, error) => {
    Logger.write(LogLevel.error, `sync_failed operation=${operation} server=${Logger.field(server)} ${Logger.failure(error)}`);
  });
  const log = new FakeLogChannel();
  const servers = new FakeServers();
  servers.ids = [A, B];
  const events = new GatewayEvents(core, new FeedbackRouter(core, log), servers);
  for (const id of [A, B]) discord.addServer(id);
  sevenTv.addUser({ id: "u1", username: "streamer", activeSetId: "setA" });
  sevenTv.addEmote({ id: "e1", name: "Pog", animated: false });
  sevenTv.setEmotes("setA", "A", ["e1"]);
  const link = (server: ServerId) => core.linkSourceSet(server, "https://7tv.app/users/u1");
  const names = (server: ServerId) => discord.emojis(server).map((e) => e.name);
  return { discord, sevenTv, store, core, log, servers, events, link, names };
}

describe("server events", () => {
  test("joining a Server registers hand-made emojis as Reserved Slots", async () => {
    const { discord, core, events } = setup();
    discord.seedEmoji(A, { name: "hand", animated: false });
    await events.serverJoined(A);
    expect((await core.status(A)).quotas.static.byTier.reserved).toBe(1);
  });

  test("leaving a Server removes its data", async () => {
    const { store, events, link } = setup();
    await link(A);
    expect(await store.listServers()).toContain(A);
    await events.serverLeft(A);
    expect(await store.listServers()).not.toContain(A);
  });

  test("a hand-deleted emoji is noticed on emoji delete and the Managed Emote comes back", async () => {
    const { discord, events, link, names } = setup();
    await link(A);
    discord.removeEmojiByHand(A, discord.emojis(A)[0]!.id);
    await events.emojiChanged(A);
    expect(names(A)).toEqual(["Pog"]);
  });

  test("a failed reconcile logs the Server and operation and keeps the admin feedback distinct", async () => {
    const { core, discord, events, log } = setup();
    await core.apply(A, new ConfigureLogChannelCommand("log"));
    const reconcile = spyOn(discord, "listEmojis").mockRejectedValueOnce(new TypeError("private detail"));
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await events.emojiChanged(A);
      expect(errors.mock.calls).toEqual([[expect.stringMatching(/ ERROR sync_failed operation=reconcile server=server-a error=TypeError$/)]]);
      expect(log.sent[0]?.embeds[0]?.description).toBe("Sync failed. Try /sync again in a moment.");
    } finally {
      reconcile.mockRestore();
      errors.mockRestore();
    }
  });

  test("a boost level change reconciles the Server", async () => {
    const { discord, core, events } = setup();
    await events.serverJoined(A);
    discord.setBoostLevel(A, 1);
    await events.boostChanged(A);
    expect((await core.status(A)).quotas.static.free).toBe(100);
  });

  test("leaving a Server cancels its paused sync", async () => {
    jest.useFakeTimers();
    try {
      const { discord, core, store, events, link } = setup();
      await link(A);
      discord.removeEmojiByHand(A, discord.emojis(A)[0]!.id);
      discord.failCreatesAfter(A, 0, new RateLimitError(1_000));
      await events.emojiChanged(A);
      await events.serverLeft(A);
      discord.allowCreates(A);
      jest.advanceTimersByTime(10_000);
      await events.idle();
      expect(await store.listServers()).not.toContain(A);
      expect((await core.status(A)).linkedUserId).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test("an unexpected failure is contained, not thrown to the gateway", async () => {
    const { events } = setup();
    await events.serverJoined("unknown-server"); // fake discord throws for unknown servers
  });
});

describe("7TV changes", () => {
  test("a Source Set change reconciles every Server with a linked user", async () => {
    const { sevenTv, events, link, names } = setup();
    await link(A);
    sevenTv.addEmote({ id: "e2", name: "Kappa", animated: false });
    sevenTv.setEmotes("setA", "A", ["e1", "e2"]);
    await events.sevenTvChanged({ type: "set-changed", setId: "setA" });
    expect(names(A).sort()).toEqual(["Kappa", "Pog"]);
  });

  test("an active set switch reconciles only Servers linked to that user", async () => {
    const { discord, sevenTv, events, link, names } = setup();
    await link(A);
    sevenTv.addEmote({ id: "e3", name: "Sadge", animated: false });
    sevenTv.setEmotes("setB", "B", ["e3"]);
    sevenTv.setActiveSet("u1", "setB");
    await events.sevenTvChanged({ type: "active-set-switched", userId: "other-user" });
    expect(names(A)).toEqual(["Pog"]);
    await events.sevenTvChanged({ type: "active-set-switched", userId: "u1" });
    expect(names(A)).toEqual(["Sadge"]);
    expect(discord.emojis(B)).toEqual([]);
  });

  test("a burst during a target scan coalesces into one follow-up scan", async () => {
    const { events, link, sevenTv, store } = setup();
    await link(A);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const listServers = store.listServers.bind(store);
    const list = spyOn(store, "listServers").mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return listServers();
    });
    const unsubscribe = events.listenToSevenTv(sevenTv);
    try {
      sevenTv.emit({ type: "set-changed", setId: "setA" });
      await started.promise;
      for (let i = 0; i < 20; i++) sevenTv.emit({ type: "active-set-switched", userId: "u1" });
      expect(list).toHaveBeenCalledTimes(1);
      release.resolve();
      await events.idle();
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await events.idle();
      unsubscribe();
      list.mockRestore();
    }
  });

  test("subscribes to the 7TV port and reconciles on its events", async () => {
    const { sevenTv, events, link, names } = setup();
    await link(A);
    events.listenToSevenTv(sevenTv);
    sevenTv.addEmote({ id: "e2", name: "Kappa", animated: false });
    sevenTv.setEmotes("setA", "A", ["e1", "e2"]);
    sevenTv.emit({ type: "set-changed", setId: "setA" });
    await events.idle();
    expect(names(A).sort()).toEqual(["Kappa", "Pog"]);
  });
});

describe("catch-up", () => {
  test("reconciles every Server the bot is in, and drops data of Servers it left while offline", async () => {
    const { discord, store, core, servers, events, link, names } = setup();
    await link(A);
    await link(B);
    discord.removeEmojiByHand(A, discord.emojis(A)[0]!.id);
    servers.ids = [A]; // B was left while the bot was offline
    await events.catchUp();
    expect(names(A)).toEqual(["Pog"]);
    expect(await store.listServers()).not.toContain(B);
    void core;
  });

  test("a setting already in progress cannot enqueue sync after the bot leaves", async () => {
    const { core, discord, events, sevenTv, store } = setup();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const resolveLink = sevenTv.resolveUserLink.bind(sevenTv);
    const resolve = spyOn(sevenTv, "resolveUserLink").mockImplementationOnce(async (link) => {
      started.resolve();
      await release.promise;
      return resolveLink(link);
    });
    const setting = core.linkSourceSet(A, "https://7tv.app/users/u1");
    try {
      await started.promise;
      const removed = events.serverLeft(A);
      release.resolve();
      expect((await setting).feedback[0]?.text).toContain("cancelled");
      await removed;
      await events.idle();
      expect(await store.listServers()).not.toContain(A);
      expect(discord.emojis(A)).toEqual([]);
    } finally {
      release.resolve();
      await setting;
      resolve.mockRestore();
    }
  });

  test("a failing Server does not stop the others", async () => {
    const { servers, events, link, names, discord } = setup();
    await link(A);
    discord.removeEmojiByHand(A, discord.emojis(A)[0]!.id);
    servers.ids = ["unknown-server", A];
    await events.catchUp();
    expect(names(A)).toEqual(["Pog"]);
  });
});

describe("feedback routing", () => {
  test("a silent automatic follow-up does not erase the last meaningful summary", async () => {
    const { core, events, link } = setup();
    await link(A);
    expect((await core.status(A)).lastSync?.changeCount).toBe(1);
    await events.emojiChanged(A);
    expect((await core.status(A)).lastSync?.changeCount).toBe(1);
  });

  test("automatic sync feedback goes to the log channel when one is set", async () => {
    const { discord, core, log, events } = setup();
    await core.apply(A, new ConfigureLogChannelCommand("chan-1"));
    discord.revokeManageExpressions(A);
    discord.seedEmoji(A, { name: "x", animated: false });
    await core.linkSourceSet(A, "https://7tv.app/users/u1"); // no permission, feedback ignored here
    expect(log.sent).toEqual([]);
    await events.emojiChanged(A);
    expect(log.sent).toHaveLength(1);
    expect(log.sent[0]!.channelId).toBe("chan-1");
    expect(log.sent[0]!.embeds).toEqual([
      { title: "Sync errors", description: expect.stringContaining("Manage Expressions") },
    ]);
  });

  test("without a log channel nothing is sent", async () => {
    const { discord, log, events, link } = setup();
    await link(A);
    discord.revokeManageExpressions(A);
    discord.removeEmojiByHand(A, discord.emojis(A)[0]!.id);
    await events.emojiChanged(A);
    expect(log.sent).toEqual([]);
  });

  test("a sync with nothing to say sends nothing", async () => {
    const { core, log, events } = setup();
    await core.apply(A, new ConfigureLogChannelCommand("chan-1"));
    await events.emojiChanged(A);
    expect(log.sent).toEqual([]);
  });

  test("a failing log channel does not break the sync", async () => {
    const { discord, core, log, events } = setup();
    await core.apply(A, new ConfigureLogChannelCommand("chan-1"));
    discord.revokeManageExpressions(A);
    discord.seedEmoji(A, { name: "x", animated: false });
    log.fail = true;
    await events.emojiChanged(A);
  });
});

test.each(["startup catch-up", "7TV change"] as const)("%s limits active reconciles and tries every Server", async (event) => {
  const { core, discord, events, servers, store } = setup();
  servers.ids = Array.from({ length: MAX_CONCURRENT_RECONCILES * 3 }, (_, i) => `target-${i}`);
  for (const server of servers.ids) {
    discord.addServer(server);
    const state = await store.load(server);
    state.linkUser("u1");
    await store.save(server, state);
  }
  const firstWave = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const attempted: ServerId[] = [];
  let active = 0;
  let peak = 0;
  const waitingServer = servers.ids[MAX_CONCURRENT_RECONCILES];
  if (!waitingServer) throw new Error("Expected a Server waiting for capacity");
  let checkingCommand = false;
  const list = spyOn(discord, "listEmojis").mockImplementation(async (server) => {
    if (checkingCommand && server === waitingServer) return [];
    attempted.push(server);
    peak = Math.max(peak, ++active);
    if (active === MAX_CONCURRENT_RECONCILES) firstWave.resolve();
    try {
      await release.promise;
      if (server === servers.ids[0]) throw new Error("one Server failed");
      return [];
    } finally {
      active--;
    }
  });
  const scheduling = event === "startup catch-up"
    ? events.catchUp()
    : events.sevenTvChanged({ type: "set-changed", setId: "setA" });
  try {
    await firstWave.promise;
    await Bun.sleep(0);
    expect(peak).toBe(MAX_CONCURRENT_RECONCILES);
    expect(attempted).toHaveLength(MAX_CONCURRENT_RECONCILES);
    checkingCommand = true;
    const command = core.apply(waitingServer, new ConfigureLogChannelCommand("log"));
    const result = await Promise.race([command, Bun.sleep(150).then(() => null)]);
    expect(result?.feedback[0]?.text).toBe("Log channel updated.");
  } finally {
    checkingCommand = false;
    release.resolve();
    await scheduling;
    list.mockRestore();
  }
  expect(peak).toBe(MAX_CONCURRENT_RECONCILES);
  expect(attempted.sort()).toEqual([...servers.ids].sort());
});
