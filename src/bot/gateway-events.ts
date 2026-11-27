import type { SyncCore, SyncObserver } from "../core/index.ts";
import type { ServerId } from "../domain/index.ts";
import type { SevenTvChange, SevenTvPort } from "../ports/index.ts";
import type { FeedbackRouter } from "./feedback-router.ts";
import { Logger, LogLevel } from "./logger.ts";

/** The Servers the bot is currently in. */
export abstract class ServerDirectory {
  public abstract serverIds(): ServerId[];
}

/** Translates gateway events into core calls; the core owns all sync scheduling and retries. */
export class GatewayEvents {
  private readonly deliveries: SyncObserver;
  private readonly pendingChanges = new Map<string, SevenTvChange>();
  private changeScan: Promise<void> | undefined;

  public constructor(
    private readonly core: SyncCore,
    feedback: FeedbackRouter,
    private readonly servers: ServerDirectory,
  ) {
    this.deliveries = (server, update) => feedback.deliverUpdate(server, update);
  }

  public serverJoined(server: ServerId): Promise<void> {
    this.queue(server);
    return this.core.syncIdle();
  }

  public async serverLeft(server: ServerId): Promise<void> {
    try {
      await this.core.removeServer(server);
    } catch (error) {
      Logger.write(LogLevel.error, `server_remove_failed operation=remove_state server=${Logger.field(server)} ${Logger.failure(error)}`);
    }
  }

  public emojiChanged(server: ServerId): Promise<void> {
    this.queue(server);
    return this.core.syncIdle();
  }

  public boostChanged(server: ServerId): Promise<void> {
    this.queue(server);
    return this.core.syncIdle();
  }

  /** Filter against current membership after reading the targets, in case a Server left while we waited. */
  public async sevenTvChanged(change: SevenTvChange): Promise<void> {
    await this.queueChange(change);
    await this.core.syncIdle();
  }

  public listenToSevenTv(sevenTv: SevenTvPort): () => void {
    return sevenTv.subscribe((change) => { void this.queueChange(change); });
  }

  /** Reconcile present Servers and remove state for Servers that left while the bot was offline. */
  public async catchUp(): Promise<void> {
    const present = new Set(this.servers.serverIds());
    for (const server of await this.core.storedServers()) {
      if (!present.has(server)) await this.serverLeft(server);
    }
    for (const server of present) this.queue(server);
    await this.core.syncIdle();
  }

  /** Wait for ready work and 7TV event delivery, without waiting for backoff timers. */
  public async idle(): Promise<void> {
    while (this.changeScan) await this.changeScan;
    await this.core.syncIdle();
  }

  private queueChange(change: SevenTvChange): Promise<void> {
    if (change.type === "set-changed") {
      this.pendingChanges.clear();
      this.pendingChanges.set("all", change);
    } else if (!this.pendingChanges.has("all")) {
      this.pendingChanges.set(`user:${change.userId}`, change);
    }
    this.changeScan ??= Promise.resolve().then(() => this.scanChanges());
    return this.changeScan;
  }

  private async scanChanges(): Promise<void> {
    try {
      while (this.pendingChanges.size) {
        const changes = [...this.pendingChanges.values()];
        this.pendingChanges.clear();
        try {
          const targets = await this.core.serversFollowing(changes);
          const present = new Set(this.servers.serverIds());
          for (const server of targets) if (present.has(server)) this.queue(server);
        } catch (error) {
          Logger.write(LogLevel.error, `seventv_change_failed operation=find_targets ${Logger.failure(error)}`);
        }
      }
    } finally {
      this.changeScan = undefined;
    }
  }

  private queue(server: ServerId): void {
    void this.core.reconcile(server, this.deliveries, "automatic").catch((error: unknown) => {
      Logger.write(LogLevel.error, `sync_failed operation=schedule server=${Logger.field(server)} ${Logger.failure(error)}`);
    });
  }
}
