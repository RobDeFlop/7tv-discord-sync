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
  private readonly permits: Array<() => void> = [];
  private activeCount = 0;
  private stopped = false;

  public constructor(
    private readonly lock: ServerLock,
    private readonly reconcile: (server: ServerId, report: SyncReport) => Promise<void>,
    private readonly onFailure: SyncFailure,
  ) {}

  /** Requests before a run starts share that run; requests during a run get one follow-up. */
  public request(server: ServerId, observer?: SyncObserver): Promise<Completion> {
    if (this.stopped) {
      const update = SyncScheduler.cancelled();
      if (observer) this.track(Promise.resolve().then(() => observer(server, update))
        .catch((error: unknown) => this.onFailure(server, "notify", error)));
      return Promise.resolve({ result: update.result });
    }
    const lane = this.lane(server);
    const batch = lane.retry ?? (lane.pending ??= new SyncBatch());
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
    return batch.pause?.result.feedback.at(-1)?.text ?? "Sync is already queued to resume.";
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
    // The permit surrounds the attempt, not time spent waiting on another Command or on backoff.
    this.track(this.lock.run(server, () => this.withPermit(async () => {
      if (this.lanes.get(server) !== lane) return;
      // A Command may have requested a priority retry before this attempt acquired the lock.
      if (batch.timer || (lane.retry && lane.retry !== batch)) {
        batch.scheduled = false;
        return;
      }
      if (lane.retry === batch) lane.retry = undefined;
      if (lane.pending === batch) lane.pending = undefined;
      lane.active = batch;
      batch.scheduled = false;
      await this.attempt(server, lane, batch);
      lane.active = undefined;
    })).then(() => {
      if (this.lanes.get(server) !== lane) return;
      if (lane.pending || lane.retry) this.start(server, lane);
      else if (!lane.active) this.lanes.delete(server);
    }).catch((error: unknown) => {
      this.onFailure(server, "reconcile", error);
      this.cancel(server);
    }));
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
    if (batch.pause && !batch.report.toResult().feedback.some((message) => message.level === "error")) {
      batch.report.say("info", "Sync resumed after Discord's rate limit.");
    }
    const result = batch.report.toResult();
    const update: SyncUpdate = { kind: "finished", result };
    this.remember(server, update);
    this.publish(server, batch, update);
    batch.finish({ result, error: failure });
  }

  private pause(server: ServerId, lane: ServerLane, batch: SyncBatch, error: RateLimitError): void {
    batch.delay = Math.max(error.retryAfterMs, Math.min(batch.delay * 2, SyncScheduler.MAX_BACKOFF_MS));
    const retryAt = Date.now() + batch.delay;
    const result = batch.report.toResult();
    result.feedback.push({
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
      feedback: update.result.feedback.slice(-6).map((message) => ({
        ...message, text: message.text.slice(0, 240).toWellFormed(),
      })),
    });
  }

  private publish(server: ServerId, batch: SyncBatch, update: SyncUpdate): void {
    for (const observer of batch.observers.keys()) this.notify(server, batch, observer, update);
  }

  private notify(server: ServerId, batch: SyncBatch, observer: SyncObserver, update: SyncUpdate): void {
    const delivery = (batch.observers.get(observer) ?? Promise.resolve())
      .then(() => observer(server, update))
      .catch((error: unknown) => this.onFailure(server, "notify", error));
    batch.observers.set(observer, delivery);
    this.track(delivery);
  }

  private track(work: Promise<void>): void {
    const tracked = work.finally(() => this.working.delete(tracked));
    this.working.add(tracked);
  }

  private async withPermit(run: () => Promise<void>): Promise<void> {
    if (this.activeCount >= MAX_CONCURRENT_RECONCILES) {
      await new Promise<void>((resolve) => this.permits.push(resolve));
    } else this.activeCount++;
    try {
      await run();
    } finally {
      const next = this.permits.shift();
      if (next) next();
      else this.activeCount--;
    }
  }

  private static cancelled(): SyncUpdate {
    return { kind: "cancelled", result: SyncReport.single("warning", "Sync cancelled because the bot left the Server or stopped.") };
  }
}
