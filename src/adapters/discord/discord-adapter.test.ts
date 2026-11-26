import { describe, expect, test } from "bun:test";
import type { EmojiImage } from "../../domain/index.ts";
import { DiscordAdapter, MissingPermissionError } from "./discord-adapter.ts";
import { GuildGateway, GuildProvider } from "./guild-gateway.ts";
import { RateLimitError, WriteQueue } from "./write-queue.ts";
import { FakeClock, flush } from "./write-queue.test.ts";

type Emoji = { id: string; name: string; animated: boolean };

class TestGuild extends GuildGateway {
  public readonly emojis = new Map<string, Emoji>();
  public readonly calls: string[] = [];
  public readonly failures: unknown[] = [];
  private n = 1;

  public constructor(
    public readonly premiumTier: number,
    private readonly canManage: boolean,
  ) {
    super();
  }

  public async canManageExpressions(): Promise<boolean> {
    return this.canManage;
  }

  public async listEmojis(): Promise<Emoji[]> {
    return [...this.emojis.values()];
  }

  public async downloadEmojiImage(emoji: Emoji): Promise<EmojiImage | null> {
    return this.emojis.has(emoji.id) ? img(emoji.animated) : null;
  }

  public async createEmoji(name: string, image: EmojiImage): Promise<Emoji> {
    this.calls.push(`create ${name}`);
    const f = this.failures.shift();
    if (f) throw f;
    const e = { id: `e${this.n++}`, name, animated: image.animated };
    this.emojis.set(e.id, e);
    return e;
  }

  public async renameEmoji(id: string, name: string): Promise<void> {
    this.calls.push(`rename ${id}`);
    this.emojis.get(id)!.name = name;
  }

  public async deleteEmoji(id: string): Promise<void> {
    this.calls.push(`delete ${id}`);
    this.emojis.delete(id);
  }
}

class TestGuilds extends GuildProvider {
  public constructor(private readonly guilds: Record<string, GuildGateway>) {
    super();
  }

  public async getGuild(server: string): Promise<GuildGateway> {
    return this.guilds[server]!;
  }
}

function fakeGuild(opts: { premiumTier?: number; canManage?: boolean } = {}) {
  const guild = new TestGuild(opts.premiumTier ?? 0, opts.canManage ?? true);
  return { guild, emojis: guild.emojis, calls: guild.calls, failures: guild.failures };
}

function setup(guilds: Record<string, GuildGateway>) {
  const clock = new FakeClock();
  const queue = new WriteQueue({ clock });
  const adapter = new DiscordAdapter(new TestGuilds(guilds), queue);
  return { adapter, clock };
}


const img = (animated: boolean) => ({ bytes: new Uint8Array([animated ? 1 : 0]), animated });

describe("DiscordAdapter", () => {
  test("reports quotas per boost level", async () => {
    const levels = [50, 100, 150, 250];
    for (const [tier, limit] of levels.entries()) {
      const { adapter } = setup({ s: fakeGuild({ premiumTier: tier }).guild });
      const quotas = await adapter.getQuotas("s");
      expect(quotas.boostLevel).toBe(tier);
      expect(quotas.limit()).toBe(limit);
    }
  });

  test("lists emojis", async () => {
    const g = fakeGuild();
    await g.guild.createEmoji("wave", img(true));
    const { adapter } = setup({ s: g.guild });
    expect(await adapter.listEmojis("s")).toEqual([{ id: "e1", name: "wave", animated: true }]);
  });

  test("downloads an existing image without requiring Manage Expressions", async () => {
    const g = fakeGuild({ canManage: false });
    const emoji = await g.guild.createEmoji("wave", img(true));
    const { adapter } = setup({ s: g.guild });
    expect(await adapter.downloadEmojiImage("s", emoji)).toEqual(img(true));
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
