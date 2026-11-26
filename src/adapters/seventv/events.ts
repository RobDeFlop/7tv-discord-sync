export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type DispatchType = "emote_set.update" | "user.update";
export interface Dispatch {
  type: DispatchType;
  /** Id of the changed set / user. */
  objectId: string;
  /** Top-level keys the update touched, when the payload says. */
  changedKeys?: string[];
}

export const EVENT_API_URL = "wss://events.7tv.io/v3";

/** Close codes that signal a bug on our side: do not blind-retry. */
const FATAL_CLOSE = new Set([4001, 4002, 4003, 4004]);

export interface EventApiOptions {
  createSocket: (url: string) => SocketLike;
  onDispatch: (d: Dispatch) => void;
  url?: string;
  /** Delay before reconnect attempt n (0-based). Injectable for tests. */
  backoffMs?: (attempt: number) => number;
}

/**
 * Minimal EventAPI v3 client: one subscription per watched set/user, resubscribes
 * after reconnects. Any dispatch is only a "dirty" signal; callers re-fetch via REST.
 */
export class EventApiClient {
  private socket: SocketLike | null = null;
  private open = false;
  private running = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly subs = new Map<string, { type: DispatchType; id: string }>();

  constructor(private readonly opts: EventApiOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.timer = this.heartbeatTimer = null;
    const s = this.socket;
    this.socket = null;
    this.open = false;
    s?.close();
  }

  watch(type: DispatchType, id: string): void {
    const key = `${type}:${id}`;
    if (this.subs.has(key)) return;
    this.subs.set(key, { type, id });
    if (this.open) this.sendSubscribe(type, id);
  }

  private sendSubscribe(type: DispatchType, id: string): void {
    this.socket?.send(JSON.stringify({ op: 35, d: { type, condition: { object_id: id } } }));
  }

  private connect(): void {
    const socket = this.opts.createSocket(this.opts.url ?? EVENT_API_URL);
    this.socket = socket;
    socket.onmessage = (ev) => this.onMessage(socket, ev.data);
    socket.onclose = (ev) => this.onClose(socket, ev.code);
    socket.onerror = () => {};
  }

  private onMessage(socket: SocketLike, raw: unknown): void {
    if (socket !== this.socket) return;
    let msg: { op: number; d?: any };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    switch (msg.op) {
      case 1: {
        this.open = true;
        this.attempt = 0;
        for (const s of this.subs.values()) this.sendSubscribe(s.type, s.id);
        this.armHeartbeat(msg.d?.heartbeat_interval);
        break;
      }
      case 2:
        this.armHeartbeat(this.lastInterval);
        break;
      case 0: {
        const d = msg.d;
        if ((d?.type === "emote_set.update" || d?.type === "user.update") && typeof d.body?.id === "string") {
          const updated: { key?: string }[] | undefined = d.body.updated;
          const changedKeys = [...(updated ?? []), ...(d.body.pushed ?? []), ...(d.body.pulled ?? [])]
            .map((c: { key?: string }) => c.key)
            .filter((k): k is string => typeof k === "string");
          this.opts.onDispatch({ type: d.type, objectId: d.body.id, changedKeys });
        }
        break;
      }
      case 4: // Reconnect
        socket.close();
        this.onClose(socket, 4000);
        break;
    }
  }

  private lastInterval = 45_000;
  private armHeartbeat(interval?: number): void {
    if (interval) this.lastInterval = interval;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    // three missed heartbeats means the connection is dead
    this.heartbeatTimer = setTimeout(() => {
      const s = this.socket;
      if (s) {
        s.close();
        this.onClose(s, 4008);
      }
    }, this.lastInterval * 3);
    (this.heartbeatTimer as { unref?: () => void }).unref?.();
  }

  private onClose(socket: SocketLike, code?: number): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.open = false;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (!this.running || (code !== undefined && FATAL_CLOSE.has(code))) return;
    const base = this.opts.backoffMs?.(this.attempt) ?? Math.min(60_000, 1000 * 2 ** this.attempt) * (0.5 + Math.random() / 2);
    // maintenance: wait at least 5 minutes
    const delay = code === 4007 ? Math.max(base, 300_000) : base;
    this.attempt++;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.running) this.connect();
    }, delay);
    (this.timer as { unref?: () => void }).unref?.();
  }
}
