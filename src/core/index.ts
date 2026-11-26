import type {
  Command,
  ServerId,
  ServerStatus,
  SyncResult,
  Quota,
  TierUsage,
} from "../domain/index.ts";
import type { DiscordPort, SevenTvPort, StorePort } from "../ports/index.ts";

export interface SyncCoreDeps {
  sevenTv: SevenTvPort;
  discord: DiscordPort;
  store: StorePort;
}

/** The sync core's public interface. Domain rules arrive in later tickets. */
export interface SyncCore {
  /** Apply an admin command to a Server. */
  apply(server: ServerId, command: Command): Promise<SyncResult>;
  /** Bring a Server's emojis in line with 7TV and the stored state. */
  reconcile(server: ServerId): Promise<SyncResult>;
  /** Used/free slots per quota and tier, plus problems. */
  status(server: ServerId): Promise<ServerStatus>;
}

export function createSyncCore(deps: SyncCoreDeps): SyncCore {
  const { discord, store } = deps;

  return {
    async apply(server, command) {
      if (command.type === "config") {
        const state = await store.load(server);
        await store.save(server, { ...state, logChannelId: command.logChannelId });
        return { changes: [], feedback: [{ level: "info", text: "Log channel updated." }] };
      }
      return {
        changes: [],
        feedback: [{ level: "error", text: `Command "${command.type}" is not implemented yet.` }],
      };
    },

    async reconcile() {
      return { changes: [], feedback: [] };
    },

    async status(server) {
      const state = await store.load(server);
      const quotas = await discord.getQuotas(server);
      const emojis = await discord.listEmojis(server);
      const usage = (quota: Quota): TierUsage => {
        const used = emojis.filter((e) => e.animated === (quota === "animated")).length;
        return {
          used,
          free: Math.max(0, quotas.limits[quota] - used),
          byTier: { reserved: used, requested: 0, source: 0, trending: 0 },
        };
      };
      return {
        quotas: { static: usage("static"), animated: usage("animated") },
        problems: state.problems,
        logChannelId: state.logChannelId,
        linkedUserId: state.linkedUserId,
        trending: state.trending,
      };
    },
  };
}
