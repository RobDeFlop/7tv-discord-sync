import type { LinkSourceSetCommand, SyncCore } from "../core/index.ts";
import type { ServerId } from "../domain/index.ts";
import { RateLimitError, type SevenTvChange, type SevenTvPort, type StorePort } from "../ports/index.ts";
import type { FeedbackRouter } from "./feedback-router.ts";
import { Logger, LogLevel } from "./logger.ts";
import type { ServerLock } from "./server-lock.ts";

interface SyncRetry {
  delay: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** The Servers the bot is currently in. */
export abstract class ServerDirectory {
  public abstract serverIds(): ServerId[];
}

/**
 * Translates Discord gateway events, 7TV changes and startup into core calls and routes
 * the feedback to the log channel. Holds no domain rules.
 */
export class GatewayEvents {
  private readonly retries = new Map<ServerId, SyncRetry>();
  private readonly inFlight = new Set<Promise<unknown>>();

  public constructor(
    private readonly core: SyncCore,
    private readonly store: StorePort,
    private readonly feedback: FeedbackRouter,
    private readonly lock: ServerLock,
    private readonly servers: ServerDirectory,
  ) {}

  /** Accept a slash command without keeping its interaction open during Discord writes. */
  public requestSync(server: ServerId, link?: LinkSourceSetCommand): void {
    void this.track(this.lock.run(server, () => this.sync(server, true, link)));
  }

  /** The bot was added to a Server; reconcile registers its hand-made emojis as Reserved Slots. */
  public serverJoined(server: ServerId): Promise<void> {
    return this.reconcile(server);
  }

  /** The bot was removed from a Server; forget everything about it. */
  public serverLeft(server: ServerId): Promise<void> {
    return this.track(this.lock.run(server, () => {
      this.clearRetry(server);
      return this.store.remove(server);
    }).catch((e) => this.report(server, e)));
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
      this.track(this.sevenTvChanged(change).catch((error) => Logger.write(LogLevel.error, "7TV change failed:", error)));
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

  private reconcile(server: ServerId, retry?: SyncRetry): Promise<void> {
    const work = this.lock
      .coalesce(server, async () => {
        if (retry && this.retries.get(server) !== retry) return; // cancelled before acquiring the lock
        await this.sync(server, false);
      })
      .catch((e) => this.report(server, e));
    return this.track(work);
  }

  private async sync(server: ServerId, requested: boolean, link?: LinkSourceSetCommand): Promise<void> {
    const retry = this.retries.get(server);
    if (!link && retry?.timer) return; // the scheduled retry covers this event
    try {
      const result = link ? await this.core.apply(server, link) : await this.core.reconcile(server);
      this.clearRetry(server);
      if ((requested || retry) && !result.feedback.some((message) => message.level === "error")) {
        result.feedback.push({ level: "info", text: `Sync complete: ${result.changes.length} emoji changes.` });
      }
      await this.feedback.deliver(server, result);
    } catch (error) {
      if (error instanceof RateLimitError) {
        await this.resumeAfterRateLimit(server, error);
        return;
      }
      this.clearRetry(server);
      this.report(server, error);
      await this.feedback.deliver(server, {
        changes: [], feedback: [{ level: "error", text: "Sync failed. Try /sync again in a moment." }],
      });
    }
  }

  /** Called under the Server lock after the write queue exhausts its own retries. */
  public async resumeAfterRateLimit(server: ServerId, error: RateLimitError): Promise<string> {
    const previous = this.retries.get(server)?.delay ?? 500;
    const delay = Math.max(error.retryAfterMs, Math.min(previous * 2, 300_000));
    this.clearRetry(server);
    const retry: SyncRetry = { delay, timer: null };
    retry.timer = setTimeout(() => {
      retry.timer = null;
      void this.reconcile(server, retry);
    }, delay);
    this.retries.set(server, retry);
    const text = `Sync paused by Discord's rate limit; it will resume in ${Math.ceil(delay / 1000)}s.`;
    await this.feedback.deliver(server, { changes: [], feedback: [{ level: "warning", text }] });
    return text;
  }

  private clearRetry(server: ServerId): void {
    const retry = this.retries.get(server);
    if (retry?.timer) clearTimeout(retry.timer);
    this.retries.delete(server);
  }

  private track(work: Promise<void>): Promise<void> {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
    return work;
  }

  private report(server: ServerId, err: unknown): void {
    Logger.write(LogLevel.error, `Sync failed for ${server}:`, err);
  }
}
