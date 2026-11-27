import { describe, expect, test } from "bun:test";
import { SyncCore } from "./index.ts";
import { FakeDiscord, FakeSevenTv, FakeStore } from "../testing/fakes.ts";

const S = "server-1";

function setup() {
  const discord = new FakeDiscord();
  discord.addServer(S, { boostLevel: 0 });
  const sevenTv = new FakeSevenTv();
  const core = new SyncCore(sevenTv, discord, new FakeStore());
  sevenTv.addUser({ id: "u1", username: "streamer", activeSetId: "setA" });
  sevenTv.addEmote({ id: "a", name: "AA", animated: false });
  sevenTv.setEmotes("setA", "Main", ["a"]);
  const names = () => discord.emojis(S).map((e) => e.name).sort();
  return { discord, core, names };
}

describe("promoting a managed emote with a requested name", () => {
  test("renames the emoji to the requested name", async () => {
    const { core, names } = setup();
    await core.linkSourceSet(S, "https://7tv.app/users/u1");
    const r = await core.addEmote(S, "https://7tv.app/emotes/a", "Wave");
    expect(names()).toEqual(["Wave"]);
    expect(r.changes).toContainEqual({ type: "renamed", from: "AA", to: "Wave" });
  });

  test("applies the collision suffix rules and records the problem", async () => {
    const { discord, core, names } = setup();
    await core.linkSourceSet(S, "https://7tv.app/users/u1");
    discord.seedEmoji(S, { name: "Wave", animated: false });
    const r = await core.addEmote(S, "https://7tv.app/emotes/a", "Wave");
    expect(names()).toEqual(["Wave", "Wave_2"]);
    expect(r.feedback.some((f) => f.level === "warning" && f.text.includes("Wave_2"))).toBe(true);
    const status = await core.status(S);
    expect(status.problems.some((p) => p.kind === "renamed-with-suffix")).toBe(true);
  });
});
