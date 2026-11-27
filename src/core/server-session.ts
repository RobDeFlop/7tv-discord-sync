import { DisplacementError, DomainError, MissingPermissionError, type ServerId, type SyncResult } from "../domain/index.ts";
import { RateLimitError, type DiscordPort, type StorePort } from "../ports/index.ts";
import type { ServerLock } from "./server-lock.ts";
import { SyncedServer } from "./synced-server.ts";
import { SyncReport } from "./sync-report.ts";

/** Owns the lock, live ownership, permissions, and persistence for a Server operation. */
export class ServerSession {
  public constructor(
    private readonly discord: DiscordPort,
    private readonly store: StorePort,
    private readonly lock: ServerLock,
  ) {}

  public async load(server: ServerId): Promise<SyncedServer> {
    const state = await this.store.load(server);
    const emojis = await this.discord.listEmojis(server);
    state.syncOwnership(emojis);
    return new SyncedServer(server, state, emojis, this.discord);
  }

  public run(server: ServerId, execute: (synced: SyncedServer, report: SyncReport) => Promise<void>): Promise<SyncResult> {
    return this.lock.run(server, async () => {
      const report = new SyncReport();
      let synced: SyncedServer | undefined;
      try {
        if (!(await this.discord.hasManageExpressions(server))) throw new MissingPermissionError(server);
        synced = await this.load(server);
        await execute(synced, report);
      } catch (error) {
        if (error instanceof DisplacementError && error.cause instanceof RateLimitError) throw error.cause;
        if (!(error instanceof DomainError)) throw error;
        const feedback = error.toFeedback();
        report.say(feedback.level, feedback.text, feedback.reason);
      } finally {
        // Persist successful writes even if a later write failed; otherwise their ownership is lost.
        if (synced) await this.store.save(server, synced.state);
      }
      return report.toResult();
    });
  }
}
