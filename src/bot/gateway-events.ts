import type { SyncCore } from "../core/index.ts";
import type { ServerId } from "../domain/index.ts";
import type { SevenTvChange, SevenTvPort, StorePort } from "../ports/index.ts";
import type { FeedbackRouter } from "./feedback-router.ts";
import type { ServerLock } from "./server-lock.ts";

/** The Servers the bot is currently in. */
export abstract class ServerDirectory {
  public abstract serverIds(): ServerId[];
}

/**
 * Translates Discord gateway events, 7TV changes and startup into core calls and routes
 * the feedback to the log channel. Holds no domain rules.
 */
export class GatewayEvents {
  private readonly inFlight = new Set<Promise<unknown>>();

  public constructor(
    private readonly core: SyncCore,
    private readonly store: StorePort,
    private readonly feedback: FeedbackRouter,
    private readonly lock: ServerLock,
    private readonly servers: ServerDirectory,
  ) {}

  /** The bot was added to a Server; reconcile registers its hand-made emojis as Reserved Slots. */
  public serverJoined(server: ServerId): Promise<void> {
    return this.reconcile(server);
  }

  /** The bot was removed from a Server; forget everything about it. */
  public serverLeft(server: ServerId): Promise<void> {
    return this.track(this.lock.run(server, () => this.store.remove(server)).catch((e) => this.report(server, e)));
  }

  /** An emoji was created, deleted or renamed. */
  public emojiChanged(server: ServerId): Promise<void> {
    return this.reconcile(server);
  }

  /** The Server's boost level changed. */
  public boostChanged(server: ServerId): Promise<void> {
    return this.reconcile(server);
  }

  /** A watched 7TV set or user changed. */
  public async sevenTvChanged(change: SevenTvChange): Promise<void> {
    const targets: ServerId[] = [];
    for (const server of await this.store.listServers()) {
      const linked = (await this.store.load(server)).linkedUserId;
      if (linked === null) continue;
      if (change.type === "active-set-switched" && linked !== change.userId) continue;
      targets.push(server);
    }
    await Promise.all(targets.map((server) => this.reconcile(server)));
  }

  /** Reconcile on every 7TV change event. Returns the unsubscribe function. */
  public listenToSevenTv(sevenTv: SevenTvPort): () => void {
    return sevenTv.subscribe((change) => {
      this.track(this.sevenTvChanged(change).catch((e) => console.error("7TV change failed:", e)));
    });
  }

  /** On startup: reconcile every Server the bot is in, and drop data of Servers it left while offline. */
  public async catchUp(): Promise<void> {
    const present = new Set(this.servers.serverIds());
    for (const server of await this.store.listServers()) {
      if (!present.has(server)) await this.serverLeft(server);
    }
    await Promise.all([...present].map((server) => this.reconcile(server)));
  }

  /** Resolves when no event is being handled. */
  public async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private reconcile(server: ServerId): Promise<void> {
    const work = this.lock
      .coalesce(server, async () => {
        const result = await this.core.reconcile(server);
        await this.feedback.deliver(server, result);
      })
      .catch((e) => this.report(server, e));
    return this.track(work);
  }

  private track(work: Promise<void>): Promise<void> {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
    return work;
  }

  private report(server: ServerId, err: unknown): void {
    console.error(`Sync failed for ${server}:`, err);
  }
}
