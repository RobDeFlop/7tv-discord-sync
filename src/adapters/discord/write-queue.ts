import { RateLimitError } from "../../ports/discord-port.ts";

export { RateLimitError };

export abstract class Clock {
  public abstract now(): number;
  public abstract sleep(ms: number): Promise<void>;
}

export class SystemClock extends Clock {
  public now(): number {
    return Date.now();
  }

  public sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export interface QueueProgress {
  /** Tasks not yet finished, including the one running or waiting to retry. */
  pending: number;
  /** Clock time the current task retries at, or null when not rate limited. */
  retryingAt: number | null;
}

interface Job {
  task: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

interface Lane {
  jobs: Job[];
  running: boolean;
  retryingAt: number | null;
}

/** Serial write queue per key (Server). Retries 429s in the background. */
export class WriteQueue {
  private readonly lanes = new Map<string, Lane>();
  private readonly clock: Clock;
  private readonly maxAttempts: number;

  public constructor(opts: { clock?: Clock; maxAttempts?: number } = {}) {
    this.clock = opts.clock ?? new SystemClock();
    this.maxAttempts = opts.maxAttempts ?? 5;
  }

  public enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { jobs: [], running: false, retryingAt: null };
      this.lanes.set(key, lane);
    }
    const l = lane;
    const promise = new Promise<T>((resolve, reject) => {
      l.jobs.push({ task, resolve: resolve as (v: unknown) => void, reject });
    });
    if (!l.running) void this.drain(l);
    return promise;
  }

  public progress(key: string): QueueProgress {
    const lane = this.lanes.get(key);
    return { pending: lane?.jobs.length ?? 0, retryingAt: lane?.retryingAt ?? null };
  }

  private async drain(lane: Lane): Promise<void> {
    lane.running = true;
    while (lane.jobs.length > 0) {
      const job = lane.jobs[0]!;
      try {
        job.resolve(await this.attempt(lane, job));
      } catch (e) {
        job.reject(e);
      }
      lane.jobs.shift();
    }
    lane.running = false;
  }

  private async attempt(lane: Lane, job: Job): Promise<unknown> {
    for (let n = 1; ; n++) {
      try {
        return await job.task();
      } catch (e) {
        if (!(e instanceof RateLimitError) || n >= this.maxAttempts) throw e;
        lane.retryingAt = this.clock.now() + e.retryAfterMs;
        await this.clock.sleep(e.retryAfterMs);
        lane.retryingAt = null;
      }
    }
  }
}
