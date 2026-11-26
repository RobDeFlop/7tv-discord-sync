import { expect, test } from "bun:test";
import { loadConfig } from "./config.ts";

test("loads token and database url from env", () => {
  expect(loadConfig({ DISCORD_TOKEN: "tok", DATABASE_URL: "postgres://x/y" })).toEqual({
    discordToken: "tok",
    databaseUrl: "postgres://x/y",
  });
});

test("names every missing variable", () => {
  expect(() => loadConfig({})).toThrow(/DISCORD_TOKEN.*DATABASE_URL/);
});
