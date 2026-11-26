import { describe, expect, spyOn, test } from "bun:test";
import { SyncCore } from "../core/index.ts";
import type { ServerId } from "../domain/index.ts";
import { FakeDiscord, FakeSevenTv, FakeStore } from "../testing/fakes.ts";
import { EmoteAddInteraction, type EmoteAddAction, type EmoteAddPreview } from "./emote-add-interaction.ts";
import { FeedbackRouter } from "./feedback-router.ts";
import { GatewayEvents } from "./gateway-events.ts";
import { FakeLogChannel, FakeServers } from "../testing/bot-fakes.ts";
import { ServerLock } from "./server-lock.ts";
import { SlashCommandRegistry } from "./slash-command-registry.ts";
import { SlashRequest, type SlashReply } from "./slash-request.ts";

const S = "server-1";
const EMOTE_LINK = "https://7tv.app/emotes/e1";

class FakeRequest extends SlashRequest {
  public readonly replies: string[] = [];
  public deferred = false;
  public preview?: EmoteAddPreview;
  public readonly userId = "admin";

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

  public async reply(reply: SlashReply): Promise<void> {
    if (typeof reply === "string") this.replies.push(reply);
    else this.preview = reply;
  }

  public get text(): string {
    return this.replies.join("\n");
  }
}

class FakeEmoteAddInteraction extends EmoteAddInteraction {
  public text = "";
  public formValue?: string;
  public deferred = false;

  public constructor(
    public readonly previewId: string,
    public readonly action: EmoteAddAction,
    public readonly userId = "admin",
    public readonly serverId = S,
    public readonly isAdministrator = true,
  ) {
    super();
  }

  public async showNameForm(originalName: string): Promise<void> {
    this.formValue = originalName;
  }

  public async defer(): Promise<void> {
    this.deferred = true;
  }

  public async reply(text: string): Promise<void> {
    this.text = text;
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
  const openPreview = async () => {
    const request = await run("emote add", { link: EMOTE_LINK });
    return request.preview!;
  };
  const interact = async (id: string, action: EmoteAddAction) => {
    const request = new FakeEmoteAddInteraction(id, action);
    await registry.handleEmoteAddInteraction(request);
    return request;
  };
  return { discord, sevenTv, store, core, lock, registry, run, openPreview, interact, events, log };
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

describe("/emote add preview", () => {
  test("shows the image and original name without importing; Add uses the displayed name", async () => {
    const { discord, sevenTv, store, openPreview, interact } = setup();
    sevenTv.renameEmote("e1", "Pog Champ");
    const preview = await openPreview();
    expect(preview.originalName).toBe("Pog Champ");
    expect(preview.defaultName).toBe("Pog_Champ");
    expect(preview.image.bytes.byteLength).toBe(1024);
    expect(discord.emojis(S)).toEqual([]);
    expect(await store.listServers()).toEqual([]);

    sevenTv.renameEmote("e1", "Changed");
    const confirmation = await interact(preview.id, { kind: "add" });
    expect(confirmation.deferred).toBe(true);
    expect(confirmation.text).toContain("Added Pog_Champ");
    expect((await store.load(S)).requestedEmotes).toEqual([{ sevenTvEmoteId: "e1", requestedName: "Pog_Champ" }]);
    expect(discord.emojis(S).map((e) => e.name)).toEqual(["Pog_Champ"]);
    expect(sevenTv.downloadCount("e1")).toBe(1);
  });

  test("prefills the original name, explains invalid names, and imports on valid submission", async () => {
    const { discord, sevenTv, openPreview, interact } = setup();
    sevenTv.renameEmote("e1", "Pog Champ");
    const { id } = await openPreview();
    expect((await interact(id, { kind: "name" })).formValue).toBe("Pog Champ");
    for (const name of ["", "P", "a".repeat(33), "Pog Champ", "Pog\n"]) {
      expect((await interact(id, { kind: "submit", name })).text).toContain("2–32 characters");
      expect(discord.emojis(S)).toEqual([]);
    }
    expect((await interact(id, { kind: "name" })).formValue).toBe("Pog Champ");
    expect((await interact(id, { kind: "submit", name: "poggers" })).text).toContain("Added poggers");
    expect(discord.emojis(S).map((e) => e.name)).toEqual(["poggers"]);
  });

  test("cancels without importing, even if a naming form was already opened", async () => {
    const { discord, store, openPreview, interact } = setup();
    const { id } = await openPreview();
    await interact(id, { kind: "name" });
    expect((await interact(id, { kind: "cancel" })).text).toContain("Cancelled");
    expect((await interact(id, { kind: "submit", name: "poggers" })).text).toContain("Run `/emote add` again");
    expect((await interact(id, { kind: "add" })).text).toContain("Run `/emote add` again");
    expect(discord.emojis(S)).toEqual([]);
    expect(await store.listServers()).toEqual([]);
  });

  test("expired previews and forms explain how to restart without importing", async () => {
    const { discord, openPreview, interact } = setup();
    const { id } = await openPreview();
    await interact(id, { kind: "name" });
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 30 * 60_000);
    try {
      for (const action of [{ kind: "add" }, { kind: "submit", name: "poggers" }] as const) {
        expect((await interact(id, action)).text).toContain("Run `/emote add` again");
      }
      expect(discord.emojis(S)).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  test.each(["add", "submit"] as const)("imports at most once when %s wins a button/form race", async (first) => {
    const { discord, openPreview, interact } = setup();
    const { id } = await openPreview();
    await interact(id, { kind: "name" });
    const add = { kind: "add" } as const;
    const submit = { kind: "submit", name: "poggers" } as const;
    const [winner, loser] = await Promise.all(first === "add"
      ? [interact(id, add), interact(id, submit)]
      : [interact(id, submit), interact(id, add)]);
    const name = first === "add" ? "Pog" : "poggers";
    expect(winner.text).toContain(`Added ${name}`);
    expect(loser.text).toContain("Run `/emote add` again");
    expect((await interact(id, add)).text).toContain("Run `/emote add` again");
    expect(discord.emojis(S).map((e) => e.name)).toEqual([name]);
  });

  test("only the initiating admin in the same Server can use a preview", async () => {
    const { discord, registry, openPreview, interact } = setup();
    const { id } = await openPreview();
    const otherUser = new FakeEmoteAddInteraction(id, { kind: "add" }, "someone-else");
    const otherServer = new FakeEmoteAddInteraction(id, { kind: "add" }, "admin", "server-2");
    const noLongerAdmin = new FakeEmoteAddInteraction(id, { kind: "add" }, "admin", S, false);
    for (const request of [otherUser, otherServer, noLongerAdmin]) {
      await registry.handleEmoteAddInteraction(request);
      expect(request.deferred).toBe(false);
    }
    expect(noLongerAdmin.text).toContain("Administrator");
    expect(discord.emojis(S)).toEqual([]);
    expect((await interact(id, { kind: "add" })).text).toContain("Added Pog");
  });

  test("reports bad links and failed downloads without opening a preview or writing state", async () => {
    const { run, sevenTv, store } = setup();
    expect((await run("emote add", { link: "nope" })).text).toContain("not a valid 7TV");
    sevenTv.disableDownload("e1");
    const request = await run("emote add", { link: EMOTE_LINK });
    expect(request.preview).toBeUndefined();
    expect(request.text).toContain("could not be downloaded");
    expect(await store.listServers()).toEqual([]);
  });
});

describe("commands translate to core calls", () => {
  test("/emote remove removes a Managed Emote", async () => {
    const { discord, openPreview, interact, run } = setup();
    await interact((await openPreview()).id, { kind: "add" });
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
    expect(emote.options?.find((o) => o.name === "add")?.options).toEqual([
      expect.objectContaining({ name: "link", required: true }),
    ]);
    for (const d of defs) expect(d.default_member_permissions).toBe("8");
  });
});
