import { describe, expect, test } from "bun:test";
import { GatewayIntentBits, RateLimitError as RestRateLimitError, type Guild } from "discord.js";
import { DiscordJsAdapter, DiscordJsGuild } from "./discordjs.ts";
import { RateLimitError } from "./write-queue.ts";

function guildWith(emojis: Record<string, unknown>): DiscordJsGuild {
  return new DiscordJsGuild({ emojis } as unknown as Guild);
}

const created = { id: "1", name: "pog", animated: false };

describe("DiscordJsGuild.downloadEmojiImage", () => {
  const client = DiscordJsAdapter.createClient();
  const guild = { client } as Guild;

  test.each([false, true])("downloads the existing emoji in the matching format (animated: %s)", async (animated) => {
    const urls: string[] = [];
    const http = async (url: string) => {
      urls.push(url);
      return new Response(new Uint8Array([1, 2, 3]));
    };
    const adapter = new DiscordJsGuild(guild, http);
    const image = await adapter.downloadEmojiImage({ ...created, animated });
    expect(image).toEqual({ bytes: new Uint8Array([1, 2, 3]), animated });
    expect(urls).toEqual([`https://cdn.discordapp.com/emojis/1.${animated ? "gif" : "png"}`]);
  });

  test("returns no image when the CDN can't serve it", async () => {
    const http = async () => new Response(null, { status: 404 });
    expect(await new DiscordJsGuild(guild, http).downloadEmojiImage(created)).toBeNull();
  });
});

describe("DiscordJsGuild.createEmoji", () => {
  test("uploads a static image as a PNG data URI", async () => {
    let sent: { attachment: unknown; name: string } | undefined;
    const guild = guildWith({
      create: async (o: { attachment: unknown; name: string }) => ((sent = o), created),
    });
    await guild.createEmoji("pog", { bytes: new Uint8Array([1, 2, 3]), animated: false });
    expect(sent?.attachment).toBe("data:image/png;base64,AQID");
    expect(sent?.name).toBe("pog");
  });

  test("uploads an animated image as a GIF data URI", async () => {
    let sent: { attachment: unknown } | undefined;
    const guild = guildWith({
      create: async (o: { attachment: unknown }) => ((sent = o), { ...created, animated: true }),
    });
    await guild.createEmoji("jam", { bytes: new Uint8Array([1, 2, 3]), animated: true });
    expect(sent?.attachment).toBe("data:image/gif;base64,AQID");
  });
});

describe("DiscordJsAdapter.createClient", () => {
  const client = DiscordJsAdapter.createClient();

  test("asks for the intents emoji events need", () => {
    expect(client.options.intents.has(GatewayIntentBits.Guilds)).toBe(true);
    expect(client.options.intents.has(GatewayIntentBits.GuildExpressions)).toBe(true);
  });

  test("rejects rate limits on emoji routes instead of sleeping on them", () => {
    const filter = client.options.rest?.rejectOnRateLimit as (info: { route: string }) => boolean;
    expect(filter({ route: "/guilds/:id/emojis" })).toBe(true);
    expect(filter({ route: "/guilds/:id/emojis/:id" })).toBe(true);
    expect(filter({ route: "/channels/:id/messages" })).toBe(false);
  });
});

describe("DiscordJsGuild rate limits", () => {
  const limited = () =>
    new RestRateLimitError({
      timeToReset: 4200,
      limit: 5,
      method: "POST",
      hash: "h",
      url: "https://discord.com/api/v10/guilds/1/emojis",
      route: "/guilds/:id/emojis",
      majorParameter: "1",
      global: false,
      retryAfter: 4200,
      sublimitTimeout: 0,
      scope: "user",
    });

  test("maps a rejected rate limit to the write queue's RateLimitError", async () => {
    const guild = guildWith({
      create: async () => {
        throw limited();
      },
    });
    const err = await guild.createEmoji("pog", { bytes: new Uint8Array(1), animated: false }).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterMs).toBe(4200);
  });

  test("maps rate limits on rename and delete too", async () => {
    const guild = guildWith({
      edit: async () => {
        throw limited();
      },
      delete: async () => {
        throw limited();
      },
    });
    expect(await guild.renameEmoji("1", "x").catch((e) => e)).toBeInstanceOf(RateLimitError);
    expect(await guild.deleteEmoji("1").catch((e) => e)).toBeInstanceOf(RateLimitError);
  });

  test("other errors pass through", async () => {
    const boom = new Error("boom");
    const guild = guildWith({
      delete: async () => {
        throw boom;
      },
    });
    expect(await guild.deleteEmoji("1").catch((e) => e)).toBe(boom);
  });
});
