import { expect, test } from "bun:test";
import {
  AddEmoteCommand,
  ConfigureLogChannelCommand,
  LinkSourceSetCommand,
  RemoveEmoteCommand,
  SyncCore,
  UnlinkSourceSetCommand,
} from "./index.ts";
import { FakeDiscord, FakeSevenTv, FakeStore } from "../testing/fakes.ts";

const SERVER = "server-1";

test("core built from fakes reconciles a Server and keeps hand-made emojis untouched", async () => {
  const discord = new FakeDiscord();
  discord.addServer(SERVER, { boostLevel: 0 });
  discord.seedEmoji(SERVER, { name: "handmade", animated: false });
  const core = new SyncCore(new FakeSevenTv(), discord, new FakeStore());

  const result = await core.reconcile(SERVER);

  expect(result.changes).toEqual([]);
  expect(discord.emojis(SERVER).map((e) => e.name)).toEqual(["handmade"]);
});

test("config command stores the log channel and returns feedback", async () => {
  const discord = new FakeDiscord();
  discord.addServer(SERVER, { boostLevel: 0 });
  const core = new SyncCore(new FakeSevenTv(), discord, new FakeStore());

  const result = await core.apply(SERVER, new ConfigureLogChannelCommand("chan-9"));

  expect(result.feedback.length).toBe(1);
  expect((await core.status(SERVER)).logChannelId).toBe("chan-9");
});

test("AddEmoteCommand snapshots a prepared emote and its image bytes at construction", async () => {
  const discord = new FakeDiscord();
  discord.addServer(SERVER);
  const store = new FakeStore();
  const core = new SyncCore(new FakeSevenTv(), discord, store);
  const bytes = Buffer.from([1, 2, 3]);
  const prepared = {
    emote: { id: "e1", name: "Original", animated: false },
    intent: "seven-tv-upload" as const,
    uploadImage: { bytes, animated: false },
    defaultName: "Displayed",
  };
  const command = new AddEmoteCommand(prepared);
  bytes.fill(0);
  prepared.uploadImage.animated = true;
  prepared.emote.id = "different";
  prepared.defaultName = "Different";

  await core.apply(SERVER, command);

  const [emoji] = discord.emojis(SERVER);
  expect(emoji?.name).toBe("Displayed");
  expect(discord.images.get(emoji!.id)).toEqual({ bytes: new Uint8Array([1, 2, 3]), animated: false });
  expect((await store.load(SERVER)).requestedEmotes).toEqual([{ sevenTvEmoteId: "e1", requestedName: "Displayed" }]);
});

test("core module imports nothing from discord.js, drizzle or sharp", async () => {
  const { Glob } = await import("bun");
  const files = [...new Glob("src/{core,domain,ports}/**/*.ts").scanSync(".")].filter(
    (f) => !f.endsWith(".test.ts"),
  );
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const text = await Bun.file(f).text();
    expect(text).not.toMatch(/from\s+["'](discord\.js|drizzle-orm|sharp|postgres)/);
  }
});
