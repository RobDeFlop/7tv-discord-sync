import { describe, expect, spyOn, test } from "bun:test";
import type { APIEmbed } from "discord.js";
import { Command, SyncCore } from "../core/index.ts";
import type { ServerId } from "../domain/index.ts";
import { FakeDiscord, FakeSevenTv, FakeStore, MAX_EMOJI_BYTES } from "../testing/fakes.ts";
import { EmoteAddInteraction, type EmoteAddAction, type EmoteAddPreview } from "./emote-add-interaction.ts";
import { FeedbackRouter } from "./feedback-router.ts";
import { GatewayEvents } from "./gateway-events.ts";
import { FakeLogChannel, FakeServers } from "../testing/bot-fakes.ts";
import { SlashCommandRegistry } from "./slash-command-registry.ts";
import { SlashRequest, type SlashReply } from "./slash-request.ts";

const S = "server-1";
const EMOTE_LINK = "https://7tv.app/emotes/e1";

class FakeRequest extends SlashRequest {
  private readonly replyHistory: SlashReply[] = [];
  private readonly editHistory: string[] = [];
  public editError?: Error;
  public deferred = false;
  public readonly userId = "admin";

  public constructor(
    public readonly commandPath: string,
    private readonly options: Record<string, string | boolean> = {},
    public readonly serverId: ServerId | null = S,
    public readonly isAdministrator = true,
    public readonly createdAt = Date.now(),
  ) {
    super();
  }

  public option(name: string): unknown {
    return this.options[name];
  }

  public async defer(): Promise<void> {
    this.deferred = true;
  }

  public async reply(reply: SlashReply): Promise<void> {
    this.replyHistory.push(structuredClone(reply));
  }

  public async editOriginal(text: string): Promise<void> {
    if (this.editError) throw this.editError;
    this.editHistory.push(text);
  }

  public get edits(): readonly string[] {
    return [...this.editHistory];
  }

  public get replies(): ReadonlyArray<SlashReply> {
    return structuredClone(this.replyHistory);
  }

  public get preview(): EmoteAddPreview | undefined {
    return this.replies.find((reply) => typeof reply !== "string" && "originalName" in reply);
  }

  public get text(): string {
    return this.replyHistory.filter((reply) => typeof reply === "string").join("\n");
  }

  public get embed(): APIEmbed {
    const [reply] = this.replies;
    if (!reply || typeof reply === "string" || "originalName" in reply || this.replyHistory.length !== 1) {
      throw new Error("Expected one embed reply");
    }
    return reply;
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

test("FakeRequest snapshots embed replies and returns independent copies", async () => {
  const req = new FakeRequest("sync");
  const embed = { title: "Sync queued", footer: { text: "Check status" } };
  await req.reply(embed);

  embed.title = "Changed input";
  embed.footer.text = "Changed input footer";
  const expected = [{ title: "Sync queued", footer: { text: "Check status" } }];
  const replies = req.replies;
  expect(replies).toEqual(expected);

  const recordedEmbed = replies[0];
  if (!recordedEmbed || typeof recordedEmbed === "string" || "originalName" in recordedEmbed) {
    throw new Error("Expected an embed reply");
  }
  recordedEmbed.footer!.text = "Changed returned footer";
  expect(req.replies).toEqual(expected);
});

function setup() {
  const discord = new FakeDiscord();
  discord.addServer(S);
  const sevenTv = new FakeSevenTv();
  const store = new FakeStore();
  const core = new SyncCore(sevenTv, discord, store);
  sevenTv.addUser({ id: "u1", username: "streamer", activeSetId: "setA" });
  sevenTv.addEmote({ id: "e1", name: "Pog", animated: false });
  sevenTv.setEmotes("setA", "A", ["e1"]);
  const log = new FakeLogChannel();
  const feedback = new FeedbackRouter(core, log);
  const events = new GatewayEvents(core, feedback, new FakeServers());
  const registry = new SlashCommandRegistry(core, feedback, log);
  const run = async (path: string, options: Record<string, string | boolean> = {}) => {
    const req = new FakeRequest(path, options);
    await registry.handle(req);
    return req;
  };
  const openPreview = async (link = EMOTE_LINK) => {
    const { preview } = await run("emote add", { link });
    if (preview?.id === undefined) throw new Error("Expected an importable emote preview");
    return preview;
  };
  const interact = async (id: string, action: EmoteAddAction) => {
    const request = new FakeEmoteAddInteraction(id, action);
    await registry.handleEmoteAddInteraction(request);
    return request;
  };
  return { discord, sevenTv, store, core, registry, run, openPreview, interact, events, log };
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

  test("/sync acknowledges the interaction before replying", async () => {
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

describe("/search", () => {
  test("only the initiating admin can confirm the catalog preview", async () => {
    const { discord, sevenTv, store, run, registry, interact } = setup();
    sevenTv.addEmote({ id: "outside-set", name: "Kappa", animated: false });
    const lookup = spyOn(sevenTv, "findEmoteByExactName");
    const denied = new FakeRequest("search", { name: "kappa" }, S, false);
    await registry.handle(denied);
    expect(denied.text).toContain("Administrator");
    expect(lookup).not.toHaveBeenCalled();

    const request = await run("search", { name: "kappa" });
    expect(request.deferred).toBe(true);
    expect(request.replies).toHaveLength(1);
    expect(request.preview).toMatchObject({ originalName: "Kappa", emoteUrl: "https://7tv.app/emotes/outside-set" });
    const id = request.preview?.id;
    if (!id) throw new Error("Expected an importable search preview");
    const other = new FakeEmoteAddInteraction(id, { kind: "add" }, "another-admin");
    await registry.handleEmoteAddInteraction(other);
    expect(other.text).toContain("no longer active");
    expect(discord.emojis(S)).toEqual([]);
    expect(await store.listServers()).toEqual([]);
    expect((await interact(id, { kind: "add" })).text).toContain("Added Kappa");
    expect((await store.load(S)).requestedEmotes).toEqual([{ sevenTvEmoteId: "outside-set", requestedName: "Kappa" }]);
    expect(discord.emojis(S).map((emoji) => emoji.name)).toEqual(["Kappa"]);
  });

  test("no match and failed lookups give distinct text replies without previews", async () => {
    const { sevenTv, run } = setup();
    const missing = await run("search", { name: "Po" });
    expect(missing.replies).toEqual([expect.stringContaining("No exact emote name matched")]);
    spyOn(sevenTv, "findEmoteByExactName").mockRejectedValueOnce(new Error("offline"));
    const failure = await run("search", { name: "Pog" });
    expect(failure.replies).toEqual([expect.stringContaining("Could not search 7TV")]);
  });
});

describe("/emote add preview", () => {
  test("shows the image and original name without importing; Add uses the displayed name", async () => {
    const { discord, sevenTv, store, openPreview, interact } = setup();
    sevenTv.renameEmote("e1", "Pog Champ");
    const preview = await openPreview();
    expect(preview.emoteUrl).toBe(EMOTE_LINK);
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

  test("oversized images still show a preview and cannot be imported or write status", async () => {
    const { discord, sevenTv, store, run } = setup();
    sevenTv.renameEmote("e1", "Original Name");
    sevenTv.setImageSize("e1", MAX_EMOJI_BYTES + 1);

    const request = await run("emote add", { link: EMOTE_LINK });

    expect(request.deferred).toBe(true);
    expect(request.preview?.originalName).toBe("Original Name");
    expect(request.preview?.image.bytes.byteLength).toBeGreaterThan(0);
    expect(request.preview?.importError).toContain("cannot be imported");
    expect(request.preview?.importError).toContain("256 KB");
    expect(request.preview?.id).toBeUndefined();
    expect(discord.emojis(S)).toEqual([]);
    expect(await store.listServers()).toEqual([]);
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
    const invalid = await run("set link", { link: "nope" });
    const link = await run("set link", { link: "https://7tv.app/users/u1" });
    expect(link.embed.title).toBe("Sync queued");
    await events.idle();
    expect(invalid.edits.at(-1)).toContain("not a valid 7TV");
    expect(link.edits.at(-1)).toContain("Linked streamer");
    expect(link.edits.at(-1)).toContain("Added Pog.");
    expect(log.sent).toEqual([]);
    expect(discord.emojis(S).map((e) => e.name)).toEqual(["Pog"]);
    await run("set unlink", { emotes: "delete" });
    expect(discord.emojis(S)).toEqual([]);
  });

  test("/set unlink keep leaves the emotes as Reserved Slots", async () => {
    const { discord, run, events } = setup();
    await run("set link", { link: "https://7tv.app/users/u1" });
    await events.idle();
    await run("set unlink", { emotes: "keep" });
    expect(discord.emojis(S).map((e) => e.name)).toEqual(["Pog"]);
  });

  test.each(["year", true])("/trending rejects invalid period %p before mutating settings", async (period) => {
    const { run, events, store, sevenTv } = setup();
    const lookups = spyOn(sevenTv, "getTrending");
    const reply = await run("trending", { state: "on", period });
    await events.idle();
    expect(reply.edits.at(-1)).toContain("Invalid Trending Fill period");
    expect(await store.listServers()).toEqual([]);
    expect(lookups).not.toHaveBeenCalled();
  });

  test("/trending on|off applies the validated period and edits the original reply", async () => {
    const { core, run, events } = setup();
    const enabled = await run("trending", { state: "on", period: "month" });
    await events.idle();
    expect(enabled.edits.at(-1)).toContain("Trending Fill is on (month)");
    expect((await core.status(S)).trending.period).toBe("month");
    const disabled = await run("trending", { state: "off" });
    await events.idle();
    expect(disabled.edits.at(-1)).toContain("Trending Fill is off");
  });

  test("status and all three queued commands acknowledge while a Server write is blocked", async () => {
    const { core, discord, events, log, run } = setup();
    await run("config log-channel", { channel: "log" });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const createEmoji = discord.createEmoji.bind(discord);
    const create = spyOn(discord, "createEmoji").mockImplementationOnce(async (server, emoji) => {
      started.resolve();
      await release.promise;
      return createEmoji(server, emoji);
    });
    const busy = core.linkSourceSet(S, "https://7tv.app/users/u1");
    await started.promise;
    const requests = Promise.all([
      run("status"), run("sync"), run("set link", { link: "https://7tv.app/users/u1" }),
      run("trending", { state: "on" }),
    ]);
    try {
      discord.setQueueProgress(S, { pending: 1, retryingAt: null });
      const replies = await Promise.race([requests, Bun.sleep(150).then(() => null)]);
      expect(replies?.[0]?.embed.fields).toContainEqual({ name: "Write queue", value: "1 write pending" });
      for (const reply of replies?.slice(1) ?? []) {
        expect(reply.embed.title).toBe("Sync queued");
        expect(reply.edits).toHaveLength(0);
      }
      expect(discord.emojis(S)).toEqual([]);
      expect(log.sent).toEqual([]);
    } finally {
      release.resolve();
      await busy;
      await events.idle();
      create.mockRestore();
    }
    const [, sync, link, trending] = await requests;
    expect(sync.edits.at(-1)).toContain("Sync complete");
    expect(link.edits.at(-1)).toContain("Linked streamer");
    expect(trending.edits.at(-1)).toContain("Trending Fill is on");
  });

  test("/sync edits its private reply with warnings instead of posting publicly", async () => {
    const { sevenTv, run, events, log } = setup();
    await run("set link", { link: "https://7tv.app/users/u1" });
    await events.idle();
    sevenTv.addEmote({ id: "e2", name: "Big", animated: false });
    sevenTv.setImageSize("e2", 10 * 1024 * 1024);
    sevenTv.setEmotes("setA", "A", ["e1", "e2"]);
    await run("config log-channel", { channel: "log" });
    const request = await run("sync");
    await events.idle();
    expect(request.edits.at(-1)).toContain("Big is still over 256 KB after conversion and was skipped.");
    expect(log.sent).toEqual([]);
  });

  test("coalesced syncs update each original private reply", async () => {
    const { core, discord, events, run } = setup();
    const gate = Promise.withResolvers<void>();
    const busy = core.apply(S, new class extends Command {
      public override execute(): Promise<void> { return gate.promise; }
    }());
    const list = spyOn(discord, "listEmojis");
    try {
      const [first, second] = await Promise.all([run("sync"), run("sync")]);
      expect(first.embed.title).toBe("Sync queued");
      expect(second.embed.title).toBe("Sync queued");
      gate.resolve();
      await busy;
      await events.idle();
      expect(first.edits).toEqual(["Sync complete: 0 emoji changes."]);
      expect(second.edits).toEqual(first.edits);
      expect(list).toHaveBeenCalledTimes(2); // the blocking Command and one reconcile
    } finally {
      gate.resolve();
      await busy;
      list.mockRestore();
    }
  });

  test("expired and failed edits for the same sync fall back to one log post", async () => {
    const { core, discord, events, log, registry, run } = setup();
    await run("config log-channel", { channel: "log" });
    const gate = Promise.withResolvers<void>();
    const busy = core.apply(S, new class extends Command {
      public override execute(): Promise<void> { return gate.promise; }
    }());
    const now = Date.now();
    const expired = new FakeRequest("sync", {}, S, true, now - 14 * 60_000);
    const failed = new FakeRequest("sync", {}, S, true, now);
    failed.editError = new Error("interaction token private-token");
    const logs = spyOn(console, "error").mockImplementation(() => {});
    const clock = spyOn(Date, "now");
    try {
      await Promise.all([registry.handle(expired), registry.handle(failed)]);
      clock.mockReturnValue(now + 61_000);
      discord.revokeManageExpressions(S);
      gate.resolve();
      await busy;
      await events.idle();
      expect(expired.edits).toEqual([]);
      expect(failed.edits).toEqual([]);
      expect(log.sent).toHaveLength(1);
      expect(log.sent[0]?.embeds[0]?.description).toContain("Manage Expressions");
      expect(logs.mock.calls.flat().join("\n")).toContain("sync_reply_edit_failed");
      expect(logs.mock.calls.flat().join("\n")).not.toContain("private-token");
      const { embed } = await run("status");
      expect(embed.fields?.find((field) => field.name === "Latest sync")?.value).toContain("Manage Expressions");
    } finally {
      clock.mockRestore();
      logs.mockRestore();
      gate.resolve();
      await busy;
      await events.idle();
    }
  });

  test("without a log channel a /sync problem is recorded for /status but not posted", async () => {
    const { sevenTv, run, events, log } = setup();
    await run("set link", { link: "https://7tv.app/users/u1" });
    await events.idle();
    sevenTv.addEmote({ id: "e2", name: "Big", animated: false });
    sevenTv.disableDownload("e2");
    sevenTv.setEmotes("setA", "A", ["e1", "e2"]);
    await run("sync");
    await events.idle();
    expect(log.sent).toEqual([]);
    const { embed } = await run("status");
    expect(embed.title).toBe("Action needed");
    expect(embed.fields).toContainEqual({ name: "Problems", value: "- Big could not be downloaded from 7TV." });
  });

  test("/config log-channel stores the channel and confirms with text", async () => {
    const { core, run } = setup();
    const req = await run("config log-channel", { channel: "chan-9" });
    expect(req.replies).toEqual(["Log channel updated."]);
    expect((await core.status(S)).logChannelId).toBe("chan-9");
  });
});

describe("/status", () => {
  test("leads with no action needed and shows unset or idle settings", async () => {
    const { run } = setup();
    const request = await run("status");
    expect(request.deferred).toBe(true);
    expect(request.embed.title).toBe("No action needed");
    expect(request.embed.fields).toContainEqual({
      name: "Settings",
      value: "Linked 7TV user: Not linked\nTrending Fill: Off (week)\nLog channel: Not set",
    });
    expect(request.embed.fields).toContainEqual({ name: "Write queue", value: "Idle" });
    expect(request.embed.fields?.some((field) => field.name === "Problems")).toBe(false);
  });

  test("names the missing permission and tells the admin what to do", async () => {
    const { discord, run } = setup();
    discord.revokeManageExpressions(S);
    const { embed } = await run("status");
    expect(embed.title).toBe("Action needed");
    expect(embed.description).toContain("Missing **Manage Expressions**");
    expect(embed.description).toContain("`/sync`");
  });

  test("separates slot usage by quota and tier, and shows configured settings and retry time", async () => {
    const { discord, sevenTv, run, events, interact } = setup();
    discord.seedEmoji(S, { name: "hand", animated: false });
    sevenTv.addEmote({ id: "requested", name: "Requested", animated: true });
    sevenTv.addEmote({ id: "trending", name: "Trending", animated: false });
    sevenTv.setTrending("month", ["trending"]);
    const { preview } = await run("emote add", { link: "https://7tv.app/emotes/requested" });
    if (preview?.id === undefined) throw new Error("Expected an importable emote preview");
    await interact(preview.id, { kind: "add" });
    await run("trending", { state: "on", period: "month" });
    await run("set link", { link: "https://7tv.app/users/u1" });
    await events.idle();
    await run("config log-channel", { channel: "1234" });
    discord.setQueueProgress(S, { pending: 4, retryingAt: 2_000_000_030_500 });

    const { embed } = await run("status");
    expect(embed.title).toBe("No action needed");
    expect(embed.fields?.map((field) => [field.name, field.value])).toEqual([
      ["Static Slots", "3/50 used\nReserved Slots: 1\nRequested Emotes: 0\nSource Set: 1\nTrending Fill: 1"],
      ["Animated Slots", "1/50 used\nReserved Slots: 0\nRequested Emotes: 1\nSource Set: 0\nTrending Fill: 0"],
      ["Settings", "Linked 7TV user: u1\nTrending Fill: On (month)\nLog channel: <#1234>"],
      ["Write queue", "4 writes pending. Rate limited by Discord; retrying <t:2000000030:R>."],
      ["Latest sync", expect.stringMatching(/\d+ emoji changes\./)],
    ]);
  });

  test("shows a rename notice without asking the admin to intervene", async () => {
    const { discord, run, events } = setup();
    discord.seedEmoji(S, { name: "Pog", animated: false });
    await run("set link", { link: "https://7tv.app/users/u1" });
    await events.idle();
    const { embed } = await run("status");
    expect(embed.title).toBe("No action needed");
    expect(embed.fields?.find((field) => field.name === "Problems")?.value).toContain("Pog");
  });

  test("fits long problem lists and says how many entries were omitted", async () => {
    const { store, run } = setup();
    const state = await store.load(S);
    const problemCount = 80;
    for (let i = 0; i < problemCount; i++) {
      state.problemLedger.observe({ kind: "too-large", message: `Problem ${i + 1}: ${"x".repeat(i === 0 ? 1500 : 50)}` });
    }
    await store.save(S, state);

    const { embed } = await run("status");
    expect(embed.title).toBe("Action needed");
    const value = embed.fields?.find((field) => field.name === "Problems")?.value ?? "";
    expect(value.length).toBeLessThanOrEqual(1024);
    const entries = value.split("\n");
    const summary = entries.pop();
    expect(entries[0]).toMatch(/^- Problem 1: .+…$/);
    expect(entries[1]).toStartWith("- Problem 2:");
    expect(entries.length).toBeLessThan(problemCount);
    expect(summary).toBe(`${problemCount - entries.length} more omitted.`);
  });
});

describe("registration", () => {
  test("groups subcommands under /emote and /set, all admin-only", () => {
    const { registry } = setup();
    const defs = registry.definitions();
    expect(defs.map((d) => d.name).sort()).toEqual(["config", "emote", "search", "set", "status", "sync", "trending"]);
    expect(defs.find((d) => d.name === "search")).toMatchObject({
      dm_permission: false, options: [{ name: "name", required: true }],
    });
    const emote = defs.find((d) => d.name === "emote")!;
    expect(emote.options?.map((o) => o.name)).toEqual(["add", "remove"]);
    expect(emote.options?.find((o) => o.name === "add")).toMatchObject({
      options: [{ name: "link", required: true }],
    });
    for (const d of defs) expect(d.default_member_permissions).toBe("8");
  });
});
