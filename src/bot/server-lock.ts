import type { ServerId } from "../domain/index.ts";

/** Runs work for one Server one task at a time, so commands and automatic syncs never interleave. */
export class ServerLock {
  private readonly tails = new Map<ServerId, Promise<unknown>>();
  private readonly waiting = new Map<ServerId, Promise<unknown>>();

  /** Run `task` once earlier tasks for the Server are done. Starts at once when the Server is idle. */
  public run<T>(server: ServerId, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(server);
    const result = previous ? previous.then(task) : task();
    const tail: Promise<unknown> = result.then(
      () => this.release(server, tail),
      () => this.release(server, tail),
    );
    this.tails.set(server, tail);
    return result;
  }

  /**
   * Like `run`, but a task already waiting for its turn covers this one too. Used for
   * reconciles: ten events while one runs need a single follow-up run, not ten.
   */
  public coalesce<T>(server: ServerId, task: () => Promise<T>): Promise<T> {
    const queued = this.waiting.get(server);
    if (queued) return queued as Promise<T>;
    let started = false;
    const result = this.run(server, () => {
      started = true;
      this.waiting.delete(server);
      return task();
    });
    // an idle Server starts the task at once; otherwise it waits and later callers join it
    if (!started) this.waiting.set(server, result);
    return result;
  }

  private release(server: ServerId, tail: Promise<unknown>): void {
    if (this.tails.get(server) === tail) this.tails.delete(server);
  }
}
