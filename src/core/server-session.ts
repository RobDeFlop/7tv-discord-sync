import { DomainError, MissingPermissionError, type ServerId } from "../domain/index.ts";
import type { DiscordPort, StorePort } from "../ports/index.ts";
import { SyncedServer } from "./synced-server.ts";
import type { SyncReport } from "./sync-report.ts";

/** Owns live ownership, permissions, and persistence while the caller holds the Server lock. */
export class ServerSession {
  public constructor(
    private readonly discord: DiscordPort,
    private readonly store: StorePort,
  ) {}

  public async load(server: ServerId): Promise<SyncedServer> {
    const state = await this.store.load(server);
    const emojis = await this.discord.listEmojis(server);
    state.syncOwnership(emojis);
    return new SyncedServer(server, state, emojis, this.discord);
  }

  public async run(server: ServerId, report: SyncReport, execute: (synced: SyncedServer) => Promise<void>): Promise<void> {
    let synced: SyncedServer | undefined;
    try {
      if (!(await this.discord.hasManageExpressions(server))) throw new MissingPermissionError(server);
      synced = await this.load(server);
      await execute(synced);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      const feedback = error.toFeedback();
      report.say(feedback.level, feedback.text, feedback.reason);
    } finally {
      // Persist successful writes even if a later write failed; otherwise their ownership is lost.
      if (synced) await this.store.save(server, synced.state);
    }
  }
}
