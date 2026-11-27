import type { FeedbackMessage, ServerId, ServerStatus, SyncResult } from "../domain/index.ts";
import { RateLimitError } from "../ports/index.ts";
import type { ServerLock } from "./server-lock.ts";
import { SyncReport } from "./sync-report.ts";

export const MAX_CONCURRENT_RECONCILES = 4;

export type SyncUpdate =
  | { kind: "paused"; result: SyncResult; retryAt: number }
  | { kind: "finished"; result: SyncResult }
  | { kind: "cancelled"; result: SyncResult };

export type SyncObserver = (server: ServerId, update: SyncUpdate, setting?: readonly FeedbackMessage[]) => Promise<void>;
export type SyncFailure = (server: ServerId, operation: "reconcile" | "notify", error: unknown) => void;

type Completion = { result: SyncResult; error?: { cause: unknown } };

class SyncBatch {
  public readonly report = new SyncReport();
  public readonly observers = new Map<SyncObserver, Promise<void>>();
  public readonly done: Promise<Completion>;
  public scheduled = false;
  public retainEmpty = false;
  public delay = 500;
  public timer: ReturnType<typeof setTimeout> | undefined;
  public pause: Extract<SyncUpdate, { kind: "paused" }> | undefined;
  public readonly finish: (completion: Completion) => void;

  public constructor() {
    const { promise, resolve } = Promise.withResolvers<Completion>();
    this.done = promise;
    this.finish = resolve;
  }
}

type SyncTrigger = "requested" | "automatic";

/** FIFO permits used independently for reconciliation and Discord result delivery. */
class WorkLimit {
  private readonly waiting: Array<() => void> = [];
  private active = 0;

  public constructor(private readonly capacity: number) {}

  public async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.capacity) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

interface ServerLane {
  active?: SyncBatch;
  pending?: SyncBatch;
  retry?: SyncBatch;
}

/** Coalesces Server work, limits active reconciles, and publishes results outside the Server lock. */
export class SyncScheduler {
  private static readonly MAX_BACKOFF_MS = 300_000;
  private readonly lanes = new Map<ServerId, ServerLane>();
  private readonly latest = new Map<ServerId, NonNullable<ServerStatus["lastSync"]>>();
  private readonly working = new Set<Promise<void>>();
  private readonly attempts = new WorkLimit(MAX_CONCURRENT_RECONCILES);
  private readonly deliveries = new WorkLimit(MAX_CONCURRENT_RECONCILES);
  private stopped = false;

  public constructor(
    private readonly lock: ServerLock,
    private readonly reconcile: (server: ServerId, report: SyncReport) => Promise<void>,
    private readonly onFailure: SyncFailure,
  ) {}

  /** Requests before a run starts share that run; requests during a run get one follow-up. */
  public request(server: ServerId, observer?: SyncObserver, trigger: SyncTrigger = "requested"): Promise<Completion> {
    if (this.stopped) {
      const update = SyncScheduler.cancelled();
      if (observer) this.track(this.deliveries.run(() => observer(server, update))
        .catch((error: unknown) => this.onFailure(server, "notify", error)));
      return Promise.resolve({ result: update.result });
    }
    const lane = this.lane(server);
    const batch = lane.retry ?? (lane.pending ??= new SyncBatch());
    batch.retainEmpty ||= trigger === "requested";
    this.observe(server, batch, observer);
    this.start(server, lane);
    return batch.done;
  }

  /** Recover the Server after a Command is interrupted, without replaying the Command. */
  public recover(server: ServerId, error: RateLimitError, partial: SyncResult): string {
    if (this.stopped) return "Sync was not queued because the bot is stopping.";
    const lane = this.lane(server);
    const batch = lane.retry ?? lane.pending ?? new SyncBatch();
    if (lane.pending === batch) lane.pending = undefined;
    batch.report.merge(partial);
    // Reset an existing pause if a later write reported a longer wait.
    if (!batch.pause || Date.now() + error.retryAfterMs > batch.pause.retryAt) {
      clearTimeout(batch.timer);
      this.pause(server, lane, batch, error);
    }
    return batch.pause?.result.feedback[0]?.text ?? "Sync is already queued to resume.";
  }

  public lastUpdate(server: ServerId): ServerStatus["lastSync"] {
    const summary = this.latest.get(server);
    return summary && { ...summary, feedback: summary.feedback.map((message) => ({ ...message })) };
  }

  public cancel(server: ServerId): void {
    const lane = this.lanes.get(server);
    this.lanes.delete(server);
    this.latest.delete(server);
    if (!lane) return;
    const update = SyncScheduler.cancelled();
    for (const batch of new Set([lane.active, lane.pending, lane.retry])) {
      if (!batch) continue;
      clearTimeout(batch.timer);
      this.publish(server, batch, update);
      batch.finish({ result: update.result });
    }
  }

  /** Wait for ready work and queued delivery, not for future retry timers. */
  public async idle(): Promise<void> {
    while (this.working.size) await Promise.all([...this.working]);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    for (const server of this.lanes.keys()) this.cancel(server);
    this.latest.clear();
    await this.idle();
  }

  private lane(server: ServerId): ServerLane {
    let lane = this.lanes.get(server);
    if (!lane) {
      lane = {};
      this.lanes.set(server, lane);
    }
    return lane;
  }

  private observe(server: ServerId, batch: SyncBatch, observer?: SyncObserver): void {
    if (!observer || batch.observers.has(observer)) return;
    batch.observers.set(observer, Promise.resolve());
    if (batch.pause) this.notify(server, batch, observer, batch.pause);
  }

  private start(server: ServerId, lane: ServerLane): void {
    const batch = lane.retry ?? lane.pending;
    if (!batch || lane.active || batch.scheduled || batch.timer) return;
    batch.scheduled = true;
    this.track(this.runWhenReady(server, lane, batch).then(() => {
      batch.scheduled = false;
      if (this.lanes.get(server) !== lane) return;
      if (lane.pending || lane.retry) this.start(server, lane);
      else if (!lane.active) this.lanes.delete(server);
    }).catch((error: unknown) => {
      this.onFailure(server, "reconcile", error);
      this.cancel(server);
    }));
  }

  private async runWhenReady(server: ServerId, lane: ServerLane, batch: SyncBatch): Promise<void> {
    for (;;) {
      await this.lock.idle(server);
      const released = await this.attempts.run(async () => {
        if (this.lanes.get(server) !== lane || batch.timer || (lane.retry && lane.retry !== batch)) return true;
        // A Command can start while this batch waits for capacity. Release the permit rather than
        // holding it while waiting; other Servers and Commands make progress independently.
        const running = this.lock.tryRun(server, async () => {
          // Removal can cancel this batch after reserving the lock but before the callback starts.
          if (this.lanes.get(server) !== lane) return;
          if (lane.retry === batch) lane.retry = undefined;
          if (lane.pending === batch) lane.pending = undefined;
          lane.active = batch;
          try {
            await this.attempt(server, lane, batch);
          } finally {
            lane.active = undefined;
          }
        });
        if (!running) return false;
        await running;
        return true;
      });
      if (released) return;
    }
  }

  private async attempt(server: ServerId, lane: ServerLane, batch: SyncBatch): Promise<void> {
    const report = new SyncReport();
    let failure: Completion["error"];
    try {
      await this.reconcile(server, report);
    } catch (error) {
      if (this.lanes.get(server) !== lane) return;
      if (error instanceof RateLimitError) {
        batch.report.merge(report.toResult());
        this.pause(server, lane, batch, error);
        return;
      }
      this.onFailure(server, "reconcile", error);
      report.say("error", "Sync failed. Try /sync again in a moment.");
      failure = { cause: error };
    }
    if (this.lanes.get(server) !== lane) return;
    batch.report.merge(report.toResult());
    const result = batch.report.toResult();
    if (batch.pause) result.feedback.unshift({ level: "info", text: "Sync resumed after Discord's rate limit." });
    const update: SyncUpdate = { kind: "finished", result };
    if (batch.retainEmpty || result.changes.length || result.feedback.length || !this.latest.has(server)) {
      this.remember(server, update);
    }
    this.publish(server, batch, update);
    batch.finish({ result, error: failure });
  }

  private pause(server: ServerId, lane: ServerLane, batch: SyncBatch, error: RateLimitError): void {
    batch.delay = Math.max(error.retryAfterMs, Math.min(batch.delay * 2, SyncScheduler.MAX_BACKOFF_MS));
    const retryAt = Date.now() + batch.delay;
    const result = batch.report.toResult();
    result.feedback.unshift({
      level: "warning",
      text: `Sync paused by Discord's rate limit; it will resume in ${Math.ceil(batch.delay / 1000)}s.`,
    });
    batch.pause = { kind: "paused", result, retryAt };
    lane.retry = batch;
    batch.timer = setTimeout(() => {
      batch.timer = undefined;
      if (this.lanes.get(server) === lane) this.start(server, lane);
    }, batch.delay);
    batch.timer.unref();
    this.remember(server, batch.pause);
    this.publish(server, batch, batch.pause);
  }

  private remember(server: ServerId, update: SyncUpdate): void {
    this.latest.set(server, {
      changeCount: update.result.changes.length,
      retryAt: update.kind === "paused" ? update.retryAt : undefined,
      feedback: SyncScheduler.summaryFeedback(update.result).map((message) => ({
        ...message, text: message.text.slice(0, 240).toWellFormed(),
      })),
    });
  }

  private static summaryFeedback(result: SyncResult): FeedbackMessage[] {
    const errors = result.feedback.filter((message) => message.level === "error").slice(-2);
    const other = result.feedback.filter((message) => message.level !== "error").slice(0, 6 - errors.length);
    return [...errors, ...other];
  }

  private publish(server: ServerId, batch: SyncBatch, update: SyncUpdate): void {
    for (const observer of batch.observers.keys()) this.notify(server, batch, observer, update);
  }

  private notify(server: ServerId, batch: SyncBatch, observer: SyncObserver, update: SyncUpdate): void {
    const delivery = (batch.observers.get(observer) ?? Promise.resolve())
      .then(() => this.deliveries.run(() => observer(server, update)))
      .catch((error: unknown) => this.onFailure(server, "notify", error));
    batch.observers.set(observer, delivery);
    this.track(delivery);
  }

  private track(work: Promise<void>): void {
    const tracked = work.finally(() => this.working.delete(tracked));
    this.working.add(tracked);
  }

  private static cancelled(): SyncUpdate {
    return { kind: "cancelled", result: SyncReport.single("warning", "Sync cancelled because the bot left the Server or stopped.") };
  }
}
