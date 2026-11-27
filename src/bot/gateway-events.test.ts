import { describe, expect, jest, test } from "bun:test";
import { RateLimitError } from "../adapters/discord/write-queue.ts";
import { ConfigureLogChannelCommand, SyncCore } from "../core/index.ts";
import type { ServerId } from "../domain/index.ts";
import { FakeDiscord, FakeSevenTv, FakeStore } from "../testing/fakes.ts";
import { FeedbackRouter } from "./feedback-router.ts";
import { GatewayEvents } from "./gateway-events.ts";
import { FakeLogChannel, FakeServers } from "../testing/bot-fakes.ts";
import { ServerLock } from "./server-lock.ts";

const A = "server-a";
const B = "server-b";

function setup() {
  const discord = new FakeDiscord();
  const sevenTv = new FakeSevenTv();
  const store = new FakeStore();
  const core = new SyncCore(sevenTv, discord, store);
  const log = new FakeLogChannel();
  const servers = new FakeServers();
  const events = new GatewayEvents(core, store, new FeedbackRouter(store, log), new ServerLock(), servers);
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

  test("a boost level change reconciles the Server", async () => {
    const { discord, core, events } = setup();
    await events.serverJoined(A);
    discord.setBoostLevel(A, 1);
    await events.boostChanged(A);
    expect((await core.status(A)).quotas.static.free).toBe(100);
  });

  test("a rate-limited sync pauses, coalesces events and resumes without another event", async () => {
    jest.useFakeTimers();
    try {
      const { discord, sevenTv, core, events, link, log, names } = setup();
      await core.apply(A, new ConfigureLogChannelCommand("log"));
      await link(A);
      sevenTv.addEmote({ id: "e2", name: "Kappa", animated: false });
      sevenTv.setEmotes("setA", "A", ["e1", "e2"]);
      discord.failCreatesAfter(A, 0, new RateLimitError(2_000));
      await events.emojiChanged(A);
      expect(log.sent[0]?.embeds[0]?.title).toBe("Sync warnings");
      expect(log.sent[0]?.embeds[0]?.description).toMatch(/paused.*resume/i);
      await events.boostChanged(A);
      jest.advanceTimersByTime(2_000);
      await events.idle();
      expect(log.sent).toHaveLength(2); // the first retry was also rate limited
      discord.allowCreates(A);
      await events.emojiChanged(A);
      jest.advanceTimersByTime(3_999);
      await events.idle();
      expect(names(A)).toEqual(["Pog"]);
      jest.advanceTimersByTime(1);
      await events.idle();
      expect(names(A).sort()).toEqual(["Kappa", "Pog"]);
    } finally {
      jest.useRealTimers();
    }
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

describe("ServerLock", () => {
  test("runs tasks for one Server one after another", async () => {
    const lock = new ServerLock();
    const order: string[] = [];
    const slow = lock.run(A, async () => {
      order.push("start1");
      await new Promise((r) => setTimeout(r, 10));
      order.push("end1");
    });
    const next = lock.run(A, async () => void order.push("start2"));
    await Promise.all([slow, next]);
    expect(order).toEqual(["start1", "end1", "start2"]);
  });

  test("coalesces tasks queued while one is waiting", async () => {
    const lock = new ServerLock();
    let runs = 0;
    const first = lock.coalesce(A, async () => void (await new Promise((r) => setTimeout(r, 10)), runs++));
    const second = lock.coalesce(A, async () => void runs++);
    const third = lock.coalesce(A, async () => void runs++);
    await Promise.all([first, second, third]);
    expect(runs).toBe(2); // the running one, plus one for everything that arrived meanwhile
  });
});
