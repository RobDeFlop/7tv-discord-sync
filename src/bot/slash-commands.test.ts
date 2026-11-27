import { describe, expect, spyOn, test } from "bun:test";
import type { APIEmbed } from "discord.js";
import { SyncCore } from "../core/index.ts";
import type { ServerId } from "../domain/index.ts";
import { FakeDiscord, FakeSevenTv, FakeStore, MAX_EMOJI_BYTES } from "../testing/fakes.ts";
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
  private readonly replyHistory: SlashReply[] = [];
  public deferred = false;
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
    this.replyHistory.push(structuredClone(reply));
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

class PreviewImageMutatingRequest extends FakeRequest {
  public override async reply(reply: SlashReply): Promise<void> {
    await super.reply(reply);
    if (typeof reply === "string" || !("originalName" in reply)) return;
    reply.image.bytes.fill(0);
    reply.image.bytes = new Uint8Array(0);
    reply.image.animated = true;
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
  const lock = new ServerLock();
  const log = new FakeLogChannel();
  const events = new GatewayEvents(core, store, new FeedbackRouter(store, log), lock, new FakeServers());
  const registry = new SlashCommandRegistry(core, lock, events, log);
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

  test("a full animated quota warns only for new animated imports and excludes Requested and Reserved slots", async () => {
    const { discord, sevenTv, run, events, openPreview, interact } = setup();
    sevenTv.addEmote({ id: "mirror", name: "Mirror", animated: true });
    sevenTv.addEmote({ id: "new", name: "New", animated: true });
    sevenTv.setEmotes("setA", "A", ["mirror"]);
    await run("set link", { link: "https://7tv.app/users/u1" });
    await events.idle();
    for (let i = 0; i < 49; i++) discord.seedEmoji(S, { name: `Reserved_${i}`, animated: true });

    expect((await openPreview()).slotNotice).toBeUndefined();
    const newLink = "https://7tv.app/emotes/new";
    const displaceable = await openPreview(newLink);
    expect(displaceable.slotNotice).toContain("animated quota is full");
    expect(displaceable.slotNotice).toContain("could remove a lower-precedence Managed Emote");

    const promotion = await openPreview("https://7tv.app/emotes/mirror");
    expect(promotion.slotNotice).toBeUndefined();
    await interact(promotion.id, { kind: "add" });
    expect((await interact(displaceable.id, { kind: "add" })).text).toContain("No free animated slot");
    const full = await openPreview(newLink);
    expect(full.slotNotice).toContain("No Managed Emote is eligible for displacement");

    const reserved = discord.emojis(S).find((emoji) => emoji.name === "Reserved_0")!;
    discord.removeEmojiByHand(S, reserved.id);
    expect((await interact(full.id, { kind: "add" })).text).toContain("Added New");
    expect(discord.emojis(S).some((emoji) => emoji.name === "Mirror")).toBe(true);
  });

  test("changing the preview image or its bytes cannot affect the uploaded image", async () => {
    const { discord, sevenTv, registry, interact } = setup();
    const bytes = Buffer.from([1, 2, 3]);
    spyOn(sevenTv, "downloadImage").mockResolvedValue({ ok: true, image: { bytes, animated: false } });
    const request = new PreviewImageMutatingRequest("emote add", { link: EMOTE_LINK });
    await registry.handle(request);
    const id = request.preview?.id;
    if (id === undefined) throw new Error("Expected an importable emote preview");

    expect((await interact(id, { kind: "add" })).text).toContain("Added Pog");
    const [emoji] = discord.emojis(S);
    expect(discord.emojiImageSnapshot(emoji!.id)).toEqual({ bytes: new Uint8Array([1, 2, 3]), animated: false });
  });

  test("previews and imports the exact available default when the original name is reserved", async () => {
    const { discord, store, openPreview, interact } = setup();
    const reserved = discord.seedEmoji(S, { name: "pog", animated: false });
    const preview = await openPreview();
    expect(preview.originalName).toBe("Pog");
    expect(preview.defaultName).toBe("Pog_2");
    expect(discord.emojis(S)).toEqual([reserved]);
    expect(await store.listServers()).toEqual([]);

    expect((await interact(preview.id, { kind: "add" })).text).toContain("Added Pog_2");
    expect(discord.emojis(S).map((e) => e.name)).toEqual(["pog", "Pog_2"]);
    expect((await store.load(S)).requestedEmotes).toEqual([{ sevenTvEmoteId: "e1", requestedName: "Pog_2" }]);
  });

  test("Add rechecks the displayed name under the Server lock and won't import under a suffix", async () => {
    const { discord, store, lock, openPreview, interact } = setup();
    const { id, defaultName } = await openPreview();
    const gate = Promise.withResolvers<void>();
    const busy = lock.run(S, async () => {
      await gate.promise;
      discord.seedEmoji(S, { name: defaultName, animated: false });
    });
    const confirmation = interact(id, { kind: "add" });
    gate.resolve();
    await busy;

    expect((await confirmation).text).toContain("Pog is already in use. Run `/emote add` again and choose another name.");
    expect(discord.emojis(S).map((e) => e.name)).toEqual(["Pog"]);
    expect((await store.load(S)).requestedEmotes).toEqual([]);
  });

  test("a submitted name that is already in use asks for a different name without importing", async () => {
    const { discord, store, openPreview, interact } = setup();
    const { id } = await openPreview();
    await interact(id, { kind: "name" });
    const reserved = discord.seedEmoji(S, { name: "poggers", animated: false });

    expect((await interact(id, { kind: "submit", name: "Poggers" })).text).toContain("choose another name");
    expect(discord.emojis(S)).toEqual([reserved]);
    expect((await store.load(S)).requestedEmotes).toEqual([]);
    const retry = await openPreview();
    expect((await interact(retry.id, { kind: "submit", name: "PogChamp" })).text).toContain("Added PogChamp");
    expect(discord.emojis(S).map((e) => e.name)).toEqual(["poggers", "PogChamp"]);
  });

  test("plain Add preserves the existing name on a Requested Emote", async () => {
    const { discord, store, openPreview, interact } = setup();
    await interact((await openPreview()).id, { kind: "submit", name: "poggers" });
    const existing = discord.emojis(S);

    const retry = await openPreview();
    expect(retry.originalName).toBe("Pog");
    expect(retry.defaultName).toBe("poggers");
    expect((await interact(retry.id, { kind: "add" })).text).toContain("poggers is already on this Server");
    expect(discord.emojis(S)).toEqual(existing);
    expect((await store.load(S)).requestedEmotes).toEqual([{ sevenTvEmoteId: "e1", requestedName: "poggers" }]);
  });

  test("an unavailable 7TV image falls back to the mirrored Discord image and Add promotes it", async () => {
    const { discord, sevenTv, store, run, events, openPreview, interact } = setup();
    await run("set link", { link: "https://7tv.app/users/u1" });
    await events.idle();
    const mirrored = discord.emojis(S)[0]!;
    const state = (await store.load(S)).toSnapshot();
    sevenTv.disableDownload("e1");

    const preview = await openPreview();
    expect(preview.image).toEqual(discord.emojiImageSnapshot(mirrored.id)!);
    expect(preview.defaultName).toBe(mirrored.name);
    expect((await store.load(S)).toSnapshot()).toEqual(state);
    expect((await interact(preview.id, { kind: "add" })).text).toContain("Pog is now a Requested Emote");
    expect(discord.emojis(S)).toEqual([mirrored]);
    expect((await store.load(S)).findManaged("e1")?.tier).toBe("requested");
  });

  test.each([
    ["unavailable", { kind: "add" }, false],
    ["oversized", { kind: "submit", name: "Poggers" }, true],
  ] as const)("a Discord preview fallback for a 7TV image marked %s cannot be imported", async (failure, action, fullQuota) => {
    const { discord, sevenTv, store, run, events, openPreview, interact } = setup();
    if (fullQuota) {
      sevenTv.addEmote({ id: "e2", name: "Other", animated: false });
      sevenTv.setEmotes("setA", "A", ["e1", "e2"]);
    }
    await run("set link", { link: "https://7tv.app/users/u1" });
    await events.idle();
    const mirrored = discord.emojis(S).find((emoji) => emoji.name === "Pog")!;
    const fallback = { bytes: new Uint8Array([91, 2, 7]), animated: false };
    discord.seedEmojiImage(mirrored.id, fallback);
    if (failure === "unavailable") sevenTv.disableDownload("e1");
    else sevenTv.setImageSize("e1", MAX_EMOJI_BYTES + 1);

    const preview = await openPreview();
    expect(preview.image).toEqual(fallback);
    if (action.kind === "submit") expect((await interact(preview.id, { kind: "name" })).formValue).toBe("Pog");

    discord.removeEmojiByHand(S, mirrored.id);
    if (fullQuota) {
      for (let i = 0; i < 49; i++) discord.seedEmoji(S, { name: `Reserved_${i}`, animated: false });
      expect(discord.emojis(S)).toHaveLength(50);
    }
    const remaining = discord.emojis(S);
    const create = spyOn(discord, "createEmoji");
    const remove = spyOn(discord, "deleteEmoji");
    const quotaLookups = discord.quotaLookups;
    const downloads = sevenTv.downloadCount("e1");

    const reply = await interact(preview.id, action);
    expect(reply.text).toContain("No emote was added. Run `/emote add` again");
    expect(create).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(discord.emojis(S)).toEqual(remaining);
    expect(discord.quotaLookups).toBe(quotaLookups);
    expect(sevenTv.downloadCount("e1")).toBe(downloads);
    expect((await store.load(S)).requestedEmotes).toEqual([]);
  });

  test.each([
    { kind: "add" },
    { kind: "submit", name: "Poggers" },
  ] as const)("a Discord fallback preview rejects $kind for a replacement emoji with the same name", async (action) => {
    const { discord, sevenTv, store, core, lock, run, events, openPreview, interact } = setup();
    await run("set link", { link: "https://7tv.app/users/u1" });
    await events.idle();
    const mirrored = discord.emojis(S)[0]!;
    sevenTv.setImageSize("e1", MAX_EMOJI_BYTES + 1);
    const preview = await openPreview();
    if (action.kind === "submit") await interact(preview.id, { kind: "name" });

    await lock.run(S, async () => {
      discord.removeEmojiByHand(S, mirrored.id);
      sevenTv.setImageSize("e1", 1024);
      await core.reconcile(S);
    });
    const replacement = discord.emojis(S)[0]!;
    expect(replacement.id).not.toBe(mirrored.id);
    expect(replacement.name).toBe(preview.defaultName);
    const managed = (await store.load(S)).findManaged("e1")?.toSnapshot();
    expect(managed).toEqual({ discordEmojiId: replacement.id, sevenTvEmoteId: "e1", tier: "source", quota: "static" });
    const rename = spyOn(discord, "renameEmoji");
    const create = spyOn(discord, "createEmoji");
    const remove = spyOn(discord, "deleteEmoji");

    const reply = await interact(preview.id, action);
    expect(reply.text).toContain("No emote was added. Run `/emote add` again to start over.");
    expect(rename).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(discord.emojis(S)).toEqual([replacement]);
    const after = await store.load(S);
    expect(after.findManaged("e1")?.toSnapshot()).toEqual(managed);
    expect(after.requestedEmotes).toEqual([]);
  });

  test("a custom name promotes and renames the same Discord emoji when using a fallback preview", async () => {
    const { discord, sevenTv, store, run, events, openPreview, interact } = setup();
    await run("set link", { link: "https://7tv.app/users/u1" });
    await events.idle();
    const mirrored = discord.emojis(S)[0]!;
    sevenTv.setImageSize("e1", MAX_EMOJI_BYTES + 1);

    const preview = await openPreview();
    expect((await interact(preview.id, { kind: "name" })).formValue).toBe("Pog");
    const create = spyOn(discord, "createEmoji");
    expect((await interact(preview.id, { kind: "submit", name: "Poggers" })).text).toContain("Poggers is now a Requested Emote");
    expect(create).not.toHaveBeenCalled();
    expect(discord.emojis(S)).toEqual([{ ...mirrored, name: "Poggers" }]);
    expect((await store.load(S)).requestedEmotes).toEqual([{ sevenTvEmoteId: "e1", requestedName: "Poggers" }]);
  });

  test("a prepared 7TV upload still works under the displayed name after the mirrored emoji is deleted", async () => {
    const { discord, sevenTv, store, run, events, openPreview, interact } = setup();
    await run("set link", { link: "https://7tv.app/users/u1" });
    await events.idle();
    const mirrored = discord.emojis(S)[0]!;
    await discord.renameEmoji(S, mirrored.id, "MirrorName");
    sevenTv.setImageSize("e1", 42);

    const preview = await openPreview();
    expect(preview.defaultName).toBe("MirrorName");
    expect(preview.image.bytes.byteLength).toBe(42);
    discord.removeEmojiByHand(S, mirrored.id);
    sevenTv.disableDownload("e1");
    const downloads = sevenTv.downloadCount("e1");

    expect((await interact(preview.id, { kind: "add" })).text).toContain("Added MirrorName");
    const [created] = discord.emojis(S);
    expect(created).toEqual({ id: expect.any(String), name: "MirrorName", animated: false });
    expect(created!.id).not.toBe(mirrored.id);
    expect(discord.emojiImageSnapshot(created!.id)).toEqual(preview.image);
    expect(sevenTv.downloadCount("e1")).toBe(downloads);
    expect((await store.load(S)).requestedEmotes).toEqual([{ sevenTvEmoteId: "e1", requestedName: "MirrorName" }]);
  });

  test("submitting a taken name doesn't rename or promote a mirrored emote", async () => {
    const { discord, store, run, events, openPreview, interact } = setup();
    await run("set link", { link: "https://7tv.app/users/u1" });
    await events.idle();
    discord.seedEmoji(S, { name: "poggers", animated: false });
    const original = discord.emojis(S);

    const { id } = await openPreview();
    expect((await interact(id, { kind: "submit", name: "poggers" })).text).toContain("choose another name");
    expect(discord.emojis(S)).toEqual(original);
    const state = await store.load(S);
    expect(state.findManaged("e1")?.tier).toBe("source");
    expect(state.requestedEmotes).toEqual([]);
  });

  test("a failed custom-name rename leaves the mirrored emote in its original tier", async () => {
    const { discord, store, run, events, openPreview, interact } = setup();
    await run("set link", { link: "https://7tv.app/users/u1" });
    await events.idle();
    const mirrored = discord.emojis(S)[0]!;
    const { id } = await openPreview();
    await interact(id, { kind: "name" });
    discord.revokeManageExpressions(S);

    const reply = await interact(id, { kind: "submit", name: "Poggers" });
    expect(reply.text).toContain("missing the Manage Expressions permission");
    expect(discord.emojis(S)).toEqual([mirrored]);
    const state = await store.load(S);
    expect(state.findManaged("e1")?.toSnapshot()).toEqual(
      { discordEmojiId: mirrored.id, sevenTvEmoteId: "e1", tier: "source", quota: "static" },
    );
    expect(state.requestedEmotes).toEqual([]);
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
    expect((await run("set link", { link: "nope" })).text).toContain("not a valid 7TV");
    expect((await run("set link", { link: "https://7tv.app/users/u1" })).text).toContain("queued");
    await events.idle();
    expect(log.sent[0]?.embeds[0]?.description).toContain("Linked streamer");
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
    const { lock, discord, events, log, run } = setup();
    await run("config log-channel", { channel: "log" });
    const gate = Promise.withResolvers<void>();
    const busy = lock.run(S, () => gate.promise);
    try {
      discord.setQueueProgress(S, { pending: 1, retryingAt: null });
      const requests = Promise.all([
        run("status"), run("sync"), run("set link", { link: "https://7tv.app/users/u1" }),
      ]);
      const replies = await Promise.race([requests, Bun.sleep(150).then(() => null)]);
      expect(replies?.[0]?.embed.fields).toContainEqual({ name: "Write queue", value: "1 write pending" });
      expect(replies?.[1]?.replies).toEqual([{
        title: "Sync queued",
        description: "Check `/status` for pending writes or the configured log channel for results.",
      }]);
      expect(replies?.[2]?.text).toContain("queued");
      expect(discord.emojis(S)).toEqual([]);
      expect(log.sent).toEqual([]);
    } finally {
      gate.resolve();
      await busy;
      await events.idle();
    }
  });

  test("/sync posts its results and warnings to the configured log channel", async () => {
    const { sevenTv, run, events, log } = setup();
    await run("set link", { link: "https://7tv.app/users/u1" });
    await events.idle();
    sevenTv.addEmote({ id: "e2", name: "Big", animated: false });
    sevenTv.setImageSize("e2", 10 * 1024 * 1024);
    sevenTv.setEmotes("setA", "A", ["e1", "e2"]);
    await run("config log-channel", { channel: "log" });
    await run("sync");
    await events.idle();
    expect(log.sent).toEqual([{
      channelId: "log",
      embeds: [
        { title: "Sync results", description: "Sync complete: 0 emoji changes." },
        { title: "Sync warnings", description: "Big is still over 256 KB after conversion and was skipped." },
      ],
    }]);
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
      state.addProblem({ kind: "too-large", message: `Problem ${i + 1}: ${"x".repeat(i === 0 ? 1500 : 50)}` });
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
    expect(defs.map((d) => d.name).sort()).toEqual(["config", "emote", "set", "status", "sync", "trending"]);
    const emote = defs.find((d) => d.name === "emote")!;
    expect(emote.options?.map((o) => o.name)).toEqual(["add", "remove"]);
    expect(emote.options?.find((o) => o.name === "add")?.options).toEqual([
      expect.objectContaining({ name: "link", required: true }),
    ]);
    for (const d of defs) expect(d.default_member_permissions).toBe("8");
  });
});
