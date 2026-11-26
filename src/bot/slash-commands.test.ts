import { describe, expect, test } from "bun:test";
import { SyncCore } from "../core/index.ts";
import type { ServerId } from "../domain/index.ts";
import { FakeDiscord, FakeSevenTv, FakeStore } from "../testing/fakes.ts";
import { FeedbackRouter } from "./feedback-router.ts";
import { GatewayEvents } from "./gateway-events.ts";
import { FakeLogChannel, FakeServers } from "../testing/bot-fakes.ts";
import { ServerLock } from "./server-lock.ts";
import { SlashCommandRegistry } from "./slash-command-registry.ts";
import { SlashRequest } from "./slash-request.ts";

const S = "server-1";

class FakeRequest extends SlashRequest {
  public readonly replies: string[] = [];
  public deferred = false;

  public constructor(
    public readonly commandPath: string,
    private readonly options: Record<string, string | boolean> = {},
    public readonly serverId: ServerId | null = S,
    public readonly isAdministrator = true,
  ) {
    super();
  }

  public stringOption(name: string): string | null {
    const v = this.options[name];
    return typeof v === "string" ? v : null;
  }

  public booleanOption(name: string): boolean | null {
    const v = this.options[name];
    return typeof v === "boolean" ? v : null;
  }

  public async defer(): Promise<void> {
    this.deferred = true;
  }

  public async reply(text: string): Promise<void> {
    this.replies.push(text);
  }

  public get text(): string {
    return this.replies.join("\n");
  }
}

function setup() {
  const discord = new FakeDiscord();
  discord.addServer(S);
  const sevenTv = new FakeSevenTv();
  const store = new FakeStore();
  const core = new SyncCore(sevenTv, discord, store);
  sevenTv.addUser({ id: "u1", username: "streamer", activeSetId: "setA" });
  sevenTv.addEmote({ id: "e1", name: "Pog", animated: false });
  sevenTv.setEmotes("setA", "A", ["e1"]);
  const lock = new ServerLock();
  const log = new FakeLogChannel();
  const events = new GatewayEvents(core, store, new FeedbackRouter(store, log), lock, new FakeServers());
  const registry = new SlashCommandRegistry(core, lock, events);
  const run = async (path: string, options: Record<string, string | boolean> = {}) => {
    const req = new FakeRequest(path, options);
    await registry.handle(req);
    return req;
  };
  return { discord, sevenTv, store, core, lock, registry, run, events, log };
}

describe("access", () => {
  test("non-administrators are refused, ephemerally, and nothing runs", async () => {
    const { registry, discord } = setup();
    const req = new FakeRequest("emote add", { link: "https://7tv.app/emotes/e1" }, S, false);
    await registry.handle(req);
    expect(req.text).toContain("Administrator");
    expect(discord.emojis(S)).toEqual([]);
  });

  test("commands outside a Server are refused", async () => {
    const { registry } = setup();
    const req = new FakeRequest("sync", {}, null);
    await registry.handle(req);
    expect(req.text).toContain("Server");
  });

  test("replies are deferred first, since syncing takes longer than Discord waits", async () => {
    const { run } = setup();
    expect((await run("sync")).deferred).toBe(true);
  });

  test("an unexpected failure is answered, not thrown", async () => {
    const { registry } = setup();
    const req = new FakeRequest("status", {}, "unknown-server");
    await registry.handle(req);
    expect(req.text).toContain("went wrong");
  });
});

describe("commands translate to core calls", () => {
  test("/emote add adds a Requested Emote with an optional name", async () => {
    const { discord, run } = setup();
    const req = await run("emote add", { link: "https://7tv.app/emotes/e1", name: "poggers" });
    expect(discord.emojis(S).map((e) => e.name)).toEqual(["poggers"]);
    expect(req.text).toContain("Added poggers");
  });

  test("/emote add with a bad link shows the core's feedback", async () => {
    const { run } = setup();
    expect((await run("emote add", { link: "nope" })).text).toContain("not a valid 7TV");
  });

  test("/emote remove removes a Managed Emote", async () => {
    const { discord, run } = setup();
    await run("emote add", { link: "https://7tv.app/emotes/e1" });
    const req = await run("emote remove", { name: "Pog" });
    expect(discord.emojis(S)).toEqual([]);
    expect(req.text).toContain("Removed Pog");
  });

  test("/set link mirrors the Source Set, /set unlink deletes or keeps its emotes", async () => {
    const { discord, run, events, log } = setup();
    await run("config log-channel", { channel: "log" });
    expect((await run("set link", { link: "nope" })).text).toContain("not a valid 7TV");
    expect((await run("set link", { link: "https://7tv.app/users/u1" })).text).toContain("queued");
    await events.idle();
    expect(log.sent[0]?.text).toContain("Linked streamer");
    expect(discord.emojis(S).map((e) => e.name)).toEqual(["Pog"]);
    await run("set unlink", { emotes: "delete" });
    expect(discord.emojis(S)).toEqual([]);
  });

  test("/set unlink keep leaves the emotes as Reserved Slots", async () => {
    const { discord, run } = setup();
    await run("set link", { link: "https://7tv.app/users/u1" });
    await run("set unlink", { emotes: "keep" });
    expect(discord.emojis(S).map((e) => e.name)).toEqual(["Pog"]);
  });

  test("/trending on|off with a period", async () => {
    const { run } = setup();
    expect((await run("trending", { state: "on", period: "month" })).text).toContain("Trending Fill is on (month)");
    expect((await run("trending", { state: "off" })).text).toContain("Trending Fill is off");
  });

  test("status, sync and set link reply while a Server write is blocked", async () => {
    const { lock, discord, run } = setup();
    const gate = Promise.withResolvers<void>();
    const busy = lock.run(S, () => gate.promise);
    try {
      discord.setQueueProgress(S, { pending: 1, retryingAt: null });
      const requests = Promise.all([
        run("status"), run("sync"), run("set link", { link: "https://7tv.app/users/u1" }),
      ]);
      const replies = await Promise.race([requests, Bun.sleep(150).then(() => null)]);
      expect(replies?.[0]?.text).toContain("1 write pending");
      expect(replies?.[1]?.text).toContain("queued");
      expect(replies?.[2]?.text).toContain("queued");
      expect(discord.emojis(S)).toEqual([]);
    } finally {
      gate.resolve();
      await busy;
    }
  });

  test("/sync reconciles and reports", async () => {
    const { discord, run, events, log } = setup();
    await run("config log-channel", { channel: "log" });
    discord.seedEmoji(S, { name: "hand", animated: false });
    expect((await run("sync")).replies).toHaveLength(1);
    await events.idle();
    expect(log.sent[0]?.text).toContain("Sync complete");
  });

  test("/config log-channel stores the channel", async () => {
    const { core, run } = setup();
    await run("config log-channel", { channel: "chan-9" });
    expect((await core.status(S)).logChannelId).toBe("chan-9");
  });

  test("/status shows slots, link, trending, problems and write-queue progress", async () => {
    const { discord, run, events } = setup();
    discord.setQueueProgress(S, { pending: 4, retryingAt: Date.now() + 30_000 });
    await run("set link", { link: "https://7tv.app/users/u1" });
    await events.idle();
    const text = (await run("status")).text;
    expect(text).toContain("Static: 1/50");
    expect(text).toContain("Animated: 0/50");
    expect(text).toContain("u1");
    expect(text).toMatch(/4 writes? pending/);
    expect(text).toMatch(/rate limited.*\ds/i);
  });
});

describe("registration", () => {
  test("groups subcommands under /emote and /set, all admin-only", () => {
    const { registry } = setup();
    const defs = registry.definitions();
    expect(defs.map((d) => d.name).sort()).toEqual(["config", "emote", "set", "status", "sync", "trending"]);
    const emote = defs.find((d) => d.name === "emote")!;
    expect(emote.options?.map((o) => o.name)).toEqual(["add", "remove"]);
    for (const d of defs) expect(d.default_member_permissions).toBe("8");
  });
});
