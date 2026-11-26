import {
  DomainError,
  ServerQuotas,
  type ServerId,
  type ServerStatus,
  type SyncResult,
  type Tier,
  type TierUsage,
  type Quota,
} from "../domain/index.ts";
import type { DiscordPort, SevenTvPort, StorePort } from "../ports/index.ts";
import type { Command } from "./commands/command.ts";
import { SyncContext } from "./sync-context.ts";
import type { SyncedServer } from "./synced-server.ts";

export * from "./commands/index.ts";

/** The sync core's public interface. */
export class SyncCore {
  private readonly context: SyncContext;

  public constructor(sevenTv: SevenTvPort, discord: DiscordPort, store: StorePort) {
    this.context = new SyncContext(sevenTv, discord, store);
  }

  /** Apply an admin command to a Server. Domain errors come back as feedback. */
  public async apply(server: ServerId, command: Command): Promise<SyncResult> {
    try {
      return await command.execute(server, this.context);
    } catch (err) {
      if (err instanceof DomainError) return { changes: [], feedback: [err.toFeedback()] };
      throw err;
    }
  }

  /** Bring a Server's emojis in line with 7TV and the stored state. */
  public reconcile(server: ServerId): Promise<SyncResult> {
    return this.context.reconciler.reconcile(server);
  }

  /** Used/free slots per quota and tier, plus problems. */
  public async status(server: ServerId): Promise<ServerStatus> {
    const synced = await this.context.load(server);
    const quotas = await this.context.discord.getQuotas(server);
    const { state } = synced;
    return {
      writeQueue: this.context.discord.queueProgress(server),
      quotas: {
        static: this.usage(synced, "static", quotas),
        animated: this.usage(synced, "animated", quotas),
      },
      problems: [...state.problems],
      logChannelId: state.logChannelId,
      linkedUserId: state.linkedUserId,
      trending: { ...state.trending },
    };
  }

  private usage(synced: SyncedServer, quota: Quota, quotas: ServerQuotas): TierUsage {
    const tierOf = new Map<string, Tier>(synced.state.managedEmotes.map((m) => [m.discordEmojiId, m.tier]));
    const byTier: Record<Tier, number> = { reserved: 0, requested: 0, source: 0, trending: 0 };
    const inQuota = synced.emojisIn(quota);
    for (const e of inQuota) byTier[tierOf.get(e.id) ?? "reserved"]++;
    return {
      used: inQuota.length,
      free: Math.max(0, quotas.limit(quota) - inQuota.length),
      byTier,
    };
  }
}
