import { PermissionFlagsBits, type Client, type Guild } from "discord.js";
import { DiscordAdapter, type GuildLike } from "./discord-adapter.ts";
import { RateLimitError, WriteQueue } from "./write-queue.ts";

const toEmoji = (e: { id: string; name: string | null; animated: boolean | null }) => ({
  id: e.id,
  name: e.name ?? "",
  animated: e.animated ?? false,
});

/** Turn a discord.js 429 into RateLimitError so the write queue retries it. */
async function mapRateLimit<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    const err = e as { status?: number; retryAfter?: number; timeToReset?: number };
    if (err?.status === 429 || err?.timeToReset !== undefined) {
      throw new RateLimitError(err.timeToReset ?? (err.retryAfter ?? 1) * 1000);
    }
    throw e;
  }
}

function wrapGuild(guild: Guild): GuildLike {
  return {
    get premiumTier() {
      return guild.premiumTier;
    },
    async canManageExpressions() {
      const me = await guild.members.fetchMe();
      return me.permissions.has(PermissionFlagsBits.ManageGuildExpressions);
    },
    async listEmojis() {
      const all = await guild.emojis.fetch();
      return [...all.values()].map(toEmoji);
    },
    createEmoji: (name, bytes) =>
      mapRateLimit(async () =>
        toEmoji(await guild.emojis.create({ attachment: Buffer.from(bytes), name })),
      ),
    async renameEmoji(id, name) {
      await mapRateLimit(() => guild.emojis.edit(id, { name }));
    },
    async deleteEmoji(id) {
      await mapRateLimit(() => guild.emojis.delete(id));
    },
  };
}

/** Production adapter over a logged-in discord.js Client. */
export function createDiscordJsAdapter(client: Client, queue = new WriteQueue()): DiscordAdapter {
  return new DiscordAdapter({
    queue,
    getGuild: async (id) => wrapGuild(await client.guilds.fetch(id)),
  });
}
