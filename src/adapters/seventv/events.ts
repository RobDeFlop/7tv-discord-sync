import { Logger, LogLevel } from "../../logger.ts";

/** The slice of a WebSocket the EventAPI client uses. */
export abstract class EventSocket {
  public onopen: ((ev: unknown) => void) | null = null;
  public onmessage: ((ev: { data: unknown }) => void) | null = null;
  public onclose: ((ev: { code?: number }) => void) | null = null;
  public onerror: ((ev: unknown) => void) | null = null;

  public abstract send(data: string): void;
  public abstract close(): void;
}

/** EventSocket over the global WebSocket. */
export class WebSocketEventSocket extends EventSocket {
  private readonly socket: WebSocket;

  public constructor(url: string) {
    super();
    this.socket = new WebSocket(url);
    this.socket.onopen = (ev) => this.onopen?.(ev);
    this.socket.onmessage = (ev) => this.onmessage?.({ data: ev.data });
    this.socket.onclose = (ev) => this.onclose?.({ code: ev.code });
    this.socket.onerror = (ev) => {
      const error: unknown = typeof ErrorEvent !== "undefined" && ev instanceof ErrorEvent ? ev.error : undefined;
      this.onerror?.(error ?? ev);
    };
  }

  public send(data: string): void {
    this.socket.send(data);
  }

  public close(): void {
    this.socket.close();
  }
}

export type DispatchType = "emote_set.update" | "user.update";
export interface Dispatch {
  type: DispatchType;
  /** Id of the changed set / user. */
  objectId: string;
  /** Top-level keys the update touched, empty if the payload does not specify any. */
  changedKeys: readonly string[];
}

export const EVENT_API_URL = "wss://events.7tv.io/v3";

/** Close codes that signal a bug on our side: do not blind-retry. */
const FATAL_CLOSE = new Set([4001, 4002, 4003, 4004]);

export interface EventApiOptions {
  createSocket: (url: string) => EventSocket;
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
  private socket: EventSocket | null = null;
  private open = false;
  private running = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private lastInterval = 45_000;
  private readonly lastLog = new Map<string, number>();
  private readonly subs = new Map<string, { type: DispatchType; id: string }>();

  public constructor(private readonly opts: EventApiOptions) {}

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  public stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.timer = this.heartbeatTimer = null;
    const s = this.socket;
    this.socket = null;
    this.open = false;
    if (s) this.close(s);
  }

  public watch(type: DispatchType, id: string): void {
    const key = `${type}:${id}`;
    if (this.subs.has(key)) return;
    this.subs.set(key, { type, id });
    if (this.open) this.sendSubscribe(type, id);
  }

  private sendSubscribe(type: DispatchType, id: string): void {
    try {
      this.socket?.send(JSON.stringify({ op: 35, d: { type, condition: { object_id: id } } }));
    } catch (error) {
      this.logFailure("seventv_socket_failed", "subscribe", Logger.failure(error));
    }
  }

  private connect(): void {
    let socket: EventSocket;
    try {
      socket = this.opts.createSocket(this.opts.url ?? EVENT_API_URL);
    } catch (error) {
      this.logFailure("seventv_socket_failed", "connect", Logger.failure(error));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onmessage = (ev) => this.onMessage(socket, ev.data);
    socket.onclose = (ev) => this.onClose(socket, ev.code);
    socket.onerror = (error) => {
      if (socket === this.socket) this.logFailure("seventv_socket_failed", "receive", Logger.failure(error));
    };
  }

  private onMessage(socket: EventSocket, raw: unknown): void {
    if (socket !== this.socket) return;
    let msg: unknown;
    if (typeof raw !== "string") {
      this.logFailure("seventv_event_invalid", "decode", "reason=non_text_frame");
      return;
    }
    try {
      msg = JSON.parse(raw);
    } catch (error) {
      this.logFailure("seventv_event_invalid", "decode", Logger.failure(error));
      return;
    }
    if (!EventApiClient.isRecord(msg) || typeof msg.op !== "number" || !Number.isSafeInteger(msg.op)) {
      this.logFailure("seventv_event_invalid", "validate_envelope", "reason=invalid_opcode");
      return;
    }
    switch (msg.op) {
      case 1: {
        const interval = EventApiClient.isRecord(msg.d) ? msg.d.heartbeat_interval : undefined;
        if (typeof interval !== "number" || !Number.isSafeInteger(interval) || interval <= 0 || interval * 3 > 2_147_483_647) {
          this.logFailure("seventv_event_invalid", "validate_hello", "reason=invalid_heartbeat_interval");
          return;
        }
        this.open = true;
        this.attempt = 0;
        for (const s of this.subs.values()) this.sendSubscribe(s.type, s.id);
        this.lastInterval = interval;
        this.armHeartbeat();
        break;
      }
      case 2:
        this.armHeartbeat();
        break;
      case 0:
        this.dispatch(msg.d);
        break;
      case 4: // Reconnect
        this.close(socket, 4000);
        break;
      case 6: { // EventAPI error packet; never log its text/body.
        const code = EventApiClient.isRecord(msg.d) ? msg.d.code : undefined;
        const details = typeof code === "number" && Number.isSafeInteger(code) ? `code=${code}` : "reason=remote_error";
        this.logFailure("seventv_socket_failed", "server_error", details);
        break;
      }
    }
  }

  private dispatch(data: unknown): void {
    if (!EventApiClient.isRecord(data) || typeof data.type !== "string") {
      this.logFailure("seventv_event_invalid", "validate_dispatch", "reason=invalid_dispatch");
      return;
    }
    const { type, body } = data;
    if (type !== "emote_set.update" && type !== "user.update") return;
    if (!EventApiClient.isRecord(body) || typeof body.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(body.id)) {
      this.logFailure("seventv_event_invalid", "validate_dispatch", "reason=invalid_body");
      return;
    }
    const keys = EventApiClient.changeKeys(body);
    if (keys === null) {
      this.logFailure("seventv_event_invalid", "validate_dispatch", "reason=invalid_changes");
      return;
    }
    try {
      this.opts.onDispatch({ type, objectId: body.id, changedKeys: keys });
    } catch (error) {
      this.logFailure("seventv_socket_failed", "dispatch", Logger.failure(error));
    }
  }

  private static changeKeys(body: Record<string, unknown>): string[] | null {
    const keys: string[] = [];
    for (const field of ["updated", "pushed", "pulled"]) {
      const changes = body[field];
      if (changes == null) continue;
      if (!Array.isArray(changes)) return null;
      for (const change of changes) {
        if (!EventApiClient.isRecord(change) || typeof change.key !== "string") return null;
        keys.push(change.key);
      }
    }
    return keys;
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private armHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    // three missed heartbeats means the connection is dead
    this.heartbeatTimer = setTimeout(() => {
      if (this.socket) this.close(this.socket, 4008);
    }, this.lastInterval * 3);
    this.heartbeatTimer.unref();
  }

  private close(socket: EventSocket, code?: number): void {
    try {
      socket.close();
    } catch (error) {
      this.logFailure("seventv_socket_failed", "close_socket", Logger.failure(error));
    }
    this.onClose(socket, code);
  }

  private onClose(socket: EventSocket, code?: number): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.open = false;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (!this.running) return;
    if (code !== 1000 && code !== 4000) {
      this.logFailure("seventv_socket_failed", "closed", Number.isSafeInteger(code) ? `code=${code}` : "reason=unknown_code");
    }
    if (code === undefined || !FATAL_CLOSE.has(code)) this.scheduleReconnect(code);
  }

  private logFailure(event: string, operation: string, details: string): void {
    // The socket can deliver malformed frames and emit errors repeatedly while reconnecting.
    const now = performance.now();
    const previous = this.lastLog.get(operation);
    if (previous !== undefined && now - previous < 60_000) return;
    this.lastLog.set(operation, now);
    Logger.write(LogLevel.warn, `${event} operation=${operation} ${details}`);
  }

  private scheduleReconnect(code?: number): void {
    const base = this.opts.backoffMs?.(this.attempt) ?? Math.min(60_000, 1000 * 2 ** this.attempt) * (0.5 + Math.random() / 2);
    // maintenance: wait at least 5 minutes
    const delay = code === 4007 ? Math.max(base, 300_000) : base;
    this.attempt++;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.running) this.connect();
    }, delay);
    this.timer.unref();
  }
}
