import { describe, expect, test } from "bun:test";
import { DiscordAdapter, MissingPermissionError, type GuildLike } from "./discord-adapter.ts";
import { RateLimitError, WriteQueue } from "./write-queue.ts";
import { FakeClock, flush } from "./write-queue.test.ts";

function fakeGuild(opts: { premiumTier?: number; canManage?: boolean } = {}) {
  const emojis = new Map<string, { id: string; name: string; animated: boolean }>();
  let n = 1;
  const calls: string[] = [];
  const failures: unknown[] = [];
  const guild: GuildLike = {
    premiumTier: opts.premiumTier ?? 0,
    async canManageExpressions() {
      return opts.canManage ?? true;
    },
    async listEmojis() {
      return [...emojis.values()];
    },
    async createEmoji(name, bytes) {
      calls.push(`create ${name}`);
      const f = failures.shift();
      if (f) throw f;
      const e = { id: `e${n++}`, name, animated: bytes[0] === 1 };
      emojis.set(e.id, e);
      return e;
    },
    async renameEmoji(id, name) {
      calls.push(`rename ${id}`);
      emojis.get(id)!.name = name;
    },
    async deleteEmoji(id) {
      calls.push(`delete ${id}`);
      emojis.delete(id);
    },
  };
  return { guild, emojis, calls, failures };
}

function setup(guilds: Record<string, GuildLike>) {
  const clock = new FakeClock();
  const queue = new WriteQueue({ clock });
  const adapter = new DiscordAdapter({ getGuild: async (id) => guilds[id]!, queue });
  return { adapter, clock };
}

const img = (animated: boolean) => ({ bytes: new Uint8Array([animated ? 1 : 0]), animated });

describe("DiscordAdapter", () => {
  test("reports quotas per boost level", async () => {
    const levels = [50, 100, 150, 250];
    for (const [tier, limit] of levels.entries()) {
      const { adapter } = setup({ s: fakeGuild({ premiumTier: tier }).guild });
      expect(await adapter.getQuotas("s")).toEqual({
        boostLevel: tier,
        limits: { static: limit, animated: limit },
      });
    }
  });

  test("lists emojis", async () => {
    const g = fakeGuild();
    await g.guild.createEmoji("wave", new Uint8Array([1]));
    const { adapter } = setup({ s: g.guild });
    expect(await adapter.listEmojis("s")).toEqual([{ id: "e1", name: "wave", animated: true }]);
  });

  test("creates, renames and deletes through the queue", async () => {
    const g = fakeGuild();
    const { adapter } = setup({ s: g.guild });
    const created = await adapter.createEmoji("s", { name: "pog", image: img(false) });
    expect(created).toEqual({ id: "e1", name: "pog", animated: false });
    await adapter.renameEmoji("s", "e1", "pogu");
    expect(g.emojis.get("e1")!.name).toBe("pogu");
    await adapter.deleteEmoji("s", "e1");
    expect(g.emojis.size).toBe(0);
  });

  test("retries a rate-limited create and exposes queue progress", async () => {
    const g = fakeGuild();
    g.failures.push(new RateLimitError(3000));
    const { adapter, clock } = setup({ s: g.guild });
    const p = adapter.createEmoji("s", { name: "pog", image: img(false) });
    await flush();
    expect(adapter.queueProgress("s")).toEqual({ pending: 1, retryingAt: 3000 });
    await clock.advance(3000);
    expect((await p).name).toBe("pog");
    expect(adapter.queueProgress("s")).toEqual({ pending: 0, retryingAt: null });
  });

  test("writes without Manage Expressions fail with MissingPermissionError", async () => {
    const g = fakeGuild({ canManage: false });
    const { adapter } = setup({ s: g.guild });
    await expect(adapter.createEmoji("s", { name: "pog", image: img(false) })).rejects.toBeInstanceOf(
      MissingPermissionError,
    );
    expect(g.calls).toEqual([]);
    expect(await adapter.hasManageExpressions("s")).toBe(false);
  });
});
