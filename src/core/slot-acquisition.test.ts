import { describe, expect, test } from "bun:test";
import { DisplacementError, ManagedEmote, ServerState } from "../domain/index.ts";
import { RateLimitError } from "../ports/index.ts";
import { FakeDiscord, FakeSevenTv, MAX_EMOJI_BYTES } from "../testing/fakes.ts";
import { SlotAcquisition } from "./slot-acquisition.ts";
import { SyncedServer } from "./synced-server.ts";
import { SyncReport } from "./sync-report.ts";

const S = "server-1";
const emote = { id: "incoming", name: "Incoming", animated: false };

function setup(reserved: number, withVictim = false, reservedName?: string) {
  const discord = new FakeDiscord();
  discord.addServer(S);
  const sevenTv = new FakeSevenTv();
  sevenTv.addEmote(emote);
  for (let i = 0; i < reserved; i++) {
    discord.seedEmoji(S, { name: i === 0 && reservedName !== undefined ? reservedName : `hand${i}`, animated: false });
  }
  const state = ServerState.empty();
  if (withVictim) {
    const victim = discord.seedEmoji(S, { name: emote.name, animated: false });
    state.addManagedEmote(new ManagedEmote(victim.id, "victim", "trending", "static"));
  }
  const emojis = discord.emojis(S);
  state.syncOwnership(emojis);
  const synced = new SyncedServer(S, state, emojis, discord);
  const report = new SyncReport();
  const acquisition = new SlotAcquisition(sevenTv);
  const acquire = () => acquisition.acquire(synced, report, { emote, tier: "source" });
  return { discord, sevenTv, synced, report, acquire };
}

describe("Slot acquisition", () => {
  test("an entirely Reserved quota stays untouched and the Source Set candidate is pending", async () => {
    const { acquire, discord, sevenTv } = setup(50);
    const before = discord.emojis(S);
    expect(await acquire()).toEqual({ kind: "pending", quota: "static", fresh: true });
    expect(await acquire()).toEqual({ kind: "pending", quota: "static", fresh: false });
    expect(sevenTv.downloadCount(emote.id)).toBe(0);
    expect(discord.emojis(S)).toEqual(before);
  });

  test("a Source Set emote displaces Trending Fill and can reuse its name", async () => {
    const { acquire, synced, report } = setup(49, true);
    expect(await acquire()).toEqual({ kind: "placed", name: emote.name });
    expect(synced.state.managedEmotes).toMatchObject([{ sevenTvEmoteId: emote.id, tier: "source" }]);
    expect(report.toResult().changes).toEqual([
      { type: "deleted", name: emote.name, reason: "displaced" },
      { type: "created", name: emote.name, sevenTvEmoteId: emote.id, tier: "source", animated: false },
    ]);
    expect(synced.state.problems).toEqual([]);
  });

  test("a failed upload leaves the displaced Managed Emote pending", async () => {
    const { acquire, discord, synced } = setup(49, true);
    discord.failCreatesAfter(S, 0, new Error("upload failed"));
    expect(await acquire()).toMatchObject({ kind: "failed", error: expect.any(DisplacementError) });
    expect(synced.state.managedEmotes).toEqual([]);
    expect(synced.state.toSnapshot().problems).toMatchObject([{ kind: "pending", sevenTvEmoteId: "victim" }]);
  });

  test("a rate limit preserves the victim's pending entry and propagates unchanged", async () => {
    const { acquire, discord, synced } = setup(49, true);
    const limited = new RateLimitError(2000);
    discord.failCreatesAfter(S, 0, limited);
    await expect(acquire()).rejects.toBe(limited);
    expect(synced.state.toSnapshot().problems).toMatchObject([{ kind: "pending", sevenTvEmoteId: "victim" }]);
  });

  test("a taken name is suffixed with feedback and recorded as a problem", async () => {
    const { acquire, synced, report } = setup(1, false, emote.name);
    expect(await acquire()).toEqual({ kind: "placed", name: "Incoming_2" });
    expect(report.toResult().feedback).toMatchObject([{ level: "warning", text: expect.stringContaining("Incoming_2") }]);
    expect(synced.state.problems).toMatchObject([{ kind: "renamed-with-suffix", sevenTvEmoteId: emote.id }]);
  });

  test.each(["skipped", "too-large"])("an unusable image (%s) warns once and never displaces", async (kind) => {
    const { acquire, sevenTv, discord, synced, report } = setup(49, true);
    if (kind === "skipped") sevenTv.disableDownload(emote.id);
    else sevenTv.setImageSize(emote.id, MAX_EMOJI_BYTES + 1);
    const before = discord.emojis(S);
    expect(await acquire()).toEqual({ kind: "skipped" });
    expect(await acquire()).toEqual({ kind: "skipped" });
    expect(discord.emojis(S)).toEqual(before);
    expect(synced.state.problems).toMatchObject([{ kind, sevenTvEmoteId: emote.id }]);
    expect(report.toResult().feedback).toHaveLength(1);
  });
});
