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
  private readonly changes = new Set<Promise<void>>();

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
      Logger.write(LogLevel.error, `server_remove_failed server=${server} error_kind=${error instanceof Error ? "Error" : typeof error}`);
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
    const targets = await this.core.serversFollowing(change);
    const present = new Set(this.servers.serverIds());
    for (const server of targets) if (present.has(server)) this.queue(server);
    await this.core.syncIdle();
  }

  public listenToSevenTv(sevenTv: SevenTvPort): () => void {
    return sevenTv.subscribe((change) => {
      const work = this.sevenTvChanged(change).catch((error: unknown) => {
        Logger.write(LogLevel.error, `seventv_change_failed operation=find_targets error_kind=${error instanceof Error ? "Error" : typeof error}`);
      }).finally(() => this.changes.delete(work));
      this.changes.add(work);
    });
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
    while (this.changes.size) await Promise.all([...this.changes]);
    await this.core.syncIdle();
  }

  private queue(server: ServerId): void {
    void this.core.reconcile(server, this.deliveries).catch((error: unknown) => {
      Logger.write(LogLevel.error, `sync_failed server=${server} operation=schedule error_kind=${error instanceof Error ? "Error" : typeof error}`);
    });
  }
}
