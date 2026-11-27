import type { ServerId } from "../domain/index.ts";

/** Serializes Server work without blocking work for other Servers. */
export class ServerLock {
  private readonly tails = new Map<ServerId, Promise<void>>();

  public run<T>(server: ServerId, task: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(server) ?? Promise.resolve()).then(task);
    const release = (): void => {
      if (this.tails.get(server) === tail) this.tails.delete(server);
    };
    const tail: Promise<void> = result.then(release, release);
    this.tails.set(server, tail);
    return result;
  }
}
