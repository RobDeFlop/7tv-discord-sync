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

// The callback settles the caller's typed result once the untyped queue has removed the job.
type Job = (lane: Lane) => Promise<() => void>;

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
      l.jobs.push(async (lane) => {
        try {
          const result = await this.attempt(lane, task);
          return () => resolve(result);
        } catch (error) {
          return () => reject(error);
        }
      });
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
    for (let job = lane.jobs[0]; job; job = lane.jobs[0]) {
      const settle = await job(lane);
      lane.jobs.shift();
      settle();
    }
    lane.running = false;
  }

  private async attempt<T>(lane: Lane, task: () => Promise<T>): Promise<T> {
    for (let n = 1; ; n++) {
      try {
        return await task();
      } catch (e) {
        if (!(e instanceof RateLimitError) || n >= this.maxAttempts) throw e;
        lane.retryingAt = this.clock.now() + e.retryAfterMs;
        await this.clock.sleep(e.retryAfterMs);
        lane.retryingAt = null;
      }
    }
  }
}
