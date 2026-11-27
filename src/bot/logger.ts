enum LogLevel {
  debug,
  info,
  warn,
  error,
}

/** Strings in the message position are display text. Pass caught values separately. */
export class Logger {
  public static debug(message: string | object, ...data: unknown[]): void {
    Logger.write("debug", message, data);
  }

  public static info(message: string | object, ...data: unknown[]): void {
    Logger.write("info", message, data);
  }

  public static warn(message: string | object, ...data: unknown[]): void {
    Logger.write("warn", message, data);
  }

  public static error(message: string | object, ...data: unknown[]): void {
    Logger.write("error", message, data);
  }

  private static write(level: keyof typeof LogLevel, message: string | object, data: unknown[]): void {
    const configured = process.env.LOG_LEVEL;
    const minimum = configured === "debug" || configured === "warn" || configured === "error" ? configured : "info";
    if (LogLevel[level] < LogLevel[minimum]) return;

    const parts = typeof message === "string" ? [message] : [];
    // REST errors may carry tokens in messages, URLs, bodies and nested causes.
    for (const value of typeof message === "string" ? data : [message, ...data]) {
      if (typeof value !== "object" || value === null) continue;
      for (const key of ["status", "code"]) {
        const number = Object.getOwnPropertyDescriptor(value, key)?.value;
        if (Number.isSafeInteger(number)) parts.push(`${key}=${number}`);
      }
    }
    console[level](`[${new Date().toISOString()}][${level}]: ${parts.join(" ") || "[redacted]"}`);
  }
}
