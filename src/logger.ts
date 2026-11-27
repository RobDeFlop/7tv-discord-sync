export enum LogLevel {
  debug,
  info,
  warn,
  error,
}

export class Logger {
  public static write(level: LogLevel, message: string): void {
    if (level < Logger.minimum()) return;
    const line = `${new Date().toISOString()} ${LogLevel[level].toUpperCase()} ${message}`;

    switch (level) {
      case LogLevel.debug: return console.debug(line);
      case LogLevel.info: return console.info(line);
      case LogLevel.warn: return console.warn(line);
      case LogLevel.error: return console.error(line);
    }
  }

  /** Keep known non-secret identifiers within a single field, including on malformed input. */
  public static field(value: string): string {
    return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "unknown";
  }

  /** Never log error names supplied on the instance, messages, stacks, URLs or SDK request data. */
  public static failure(error: unknown): string {
    try {
      const fields = [`error=${Logger.errorClass(error)}`];
      const cause = Logger.ownValue(error, "cause");
      if (cause !== undefined) fields.push(`cause=${Logger.errorClass(cause)}`);
      for (const key of ["status", "code"]) {
        const value = Logger.ownValue(error, key) ?? Logger.ownValue(cause, key);
        if (typeof value === "number" && Number.isSafeInteger(value)) fields.push(`${key}=${value}`);
      }
      return fields.join(" ");
    } catch {
      // Even reflection on unknown errors can fail (e.g. if it is a revoked Proxy).
      return "error=unknown reason=inspection_failed";
    }
  }

  private static ownValue(value: unknown, key: string): unknown {
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
      return Object.getOwnPropertyDescriptor(value, key)?.value;
    }
    return undefined;
  }

  private static errorClass(value: unknown): string {
    if (!(value instanceof Error)) return value === null ? "null" : typeof value;
    const prototype: unknown = Object.getPrototypeOf(value);
    const name = Logger.ownValue(Logger.ownValue(prototype, "constructor"), "name");
    return typeof name === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(name) ? name : "Error";
  }

  private static minimum(): LogLevel {
    switch (process.env.LOG_LEVEL?.toLowerCase()) {
      case "debug": return LogLevel.debug;
      case "warn": return LogLevel.warn;
      case "error": return LogLevel.error;
      default: return LogLevel.info;
    }
  }
}
