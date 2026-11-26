import { expect, test } from "bun:test";
import { Config } from "./config.ts";

test("loads token and database url from env", () => {
  expect(Config.fromEnv({ DISCORD_TOKEN: "tok", DATABASE_URL: "postgres://x/y" })).toEqual({
    discordToken: "tok",
    databaseUrl: "postgres://x/y",
  });
});

test("names every missing variable", () => {
  expect(() => Config.fromEnv({})).toThrow(/DISCORD_TOKEN.*DATABASE_URL/);
});
