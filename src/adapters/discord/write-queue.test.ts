import { describe, expect, test } from "bun:test";
import { RateLimitError, WriteQueue, type Clock } from "./write-queue.ts";

export class FakeClock implements Clock {
  private t = 0;
  private timers: { at: number; resolve: () => void }[] = [];
  now() {
    return this.t;
  }
  sleep(ms: number) {
    return new Promise<void>((resolve) => this.timers.push({ at: this.t + ms, resolve }));
  }
  async advance(ms: number) {
    this.t += ms;
    const due = this.timers.filter((x) => x.at <= this.t);
    this.timers = this.timers.filter((x) => x.at > this.t);
    due.forEach((x) => x.resolve());
    await flush();
  }
}
export const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("WriteQueue", () => {
  test("runs one server's tasks in order, one at a time", async () => {
    const q = new WriteQueue({ clock: new FakeClock() });
    const log: string[] = [];
    const task = (n: string) => async () => {
      log.push(`start ${n}`);
      await flush();
      log.push(`end ${n}`);
      return n;
    };
    const results = await Promise.all([q.enqueue("s", task("a")), q.enqueue("s", task("b"))]);
    expect(results).toEqual(["a", "b"]);
    expect(log).toEqual(["start a", "end a", "start b", "end b"]);
  });

  test("retries a 429 after the retry-after delay, in the background", async () => {
    const clock = new FakeClock();
    const q = new WriteQueue({ clock });
    let calls = 0;
    const p = q.enqueue("s", async () => {
      if (++calls === 1) throw new RateLimitError(5000);
      return "ok";
    });
    await flush();
    expect(calls).toBe(1);
    expect(q.progress("s")).toEqual({ pending: 1, retryingAt: 5000 });
    await clock.advance(4999);
    expect(calls).toBe(1);
    await clock.advance(1);
    expect(await p).toBe("ok");
    expect(q.progress("s")).toEqual({ pending: 0, retryingAt: null });
  });

  test("a rate-limited server does not block another server", async () => {
    const q = new WriteQueue({ clock: new FakeClock() });
    const a = q.enqueue("a", async () => {
      throw new RateLimitError(60_000);
    });
    a.catch(() => {});
    const b = await q.enqueue("b", async () => "done");
    expect(b).toBe("done");
    expect(q.progress("a").pending).toBe(1);
    expect(q.progress("b").pending).toBe(0);
  });

  test("gives up after max attempts and moves on to the next task", async () => {
    const clock = new FakeClock();
    const q = new WriteQueue({ clock, maxAttempts: 2 });
    const failing = q.enqueue("s", async () => {
      throw new RateLimitError(100);
    });
    failing.catch(() => {});
    const next = q.enqueue("s", async () => "next");
    await flush();
    await clock.advance(100);
    await expect(failing).rejects.toBeInstanceOf(RateLimitError);
    expect(await next).toBe("next");
  });

  test("other errors reject immediately without retry", async () => {
    const q = new WriteQueue({ clock: new FakeClock() });
    let calls = 0;
    await expect(
      q.enqueue("s", async () => {
        calls++;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });
});
