import { expect, test } from "bun:test";
import { createSyncCore } from "./index.ts";
import { FakeDiscord, FakeSevenTv, FakeStore } from "../testing/fakes.ts";

const SERVER = "server-1";

test("core built from fakes reconciles a Server and keeps hand-made emojis untouched", async () => {
  const discord = new FakeDiscord();
  discord.addServer(SERVER, { boostLevel: 0 });
  discord.seedEmoji(SERVER, { name: "handmade", animated: false });
  const core = createSyncCore({ sevenTv: new FakeSevenTv(), discord, store: new FakeStore() });

  const result = await core.reconcile(SERVER);

  expect(result.changes).toEqual([]);
  expect(discord.emojis(SERVER).map((e) => e.name)).toEqual(["handmade"]);
});

test("config command stores the log channel and returns feedback", async () => {
  const discord = new FakeDiscord();
  discord.addServer(SERVER, { boostLevel: 0 });
  const core = createSyncCore({ sevenTv: new FakeSevenTv(), discord, store: new FakeStore() });

  const result = await core.apply(SERVER, { type: "config", logChannelId: "chan-9" });

  expect(result.feedback.length).toBe(1);
  expect((await core.status(SERVER)).logChannelId).toBe("chan-9");
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
