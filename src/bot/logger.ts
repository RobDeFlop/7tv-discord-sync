enum LogLevel {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
  Error = "error",
}

const levels = Object.values(LogLevel); // Lowest to highest severity.

/** Strings in the message position are display text. Pass caught values separately. */
export class Logger {
  public static debug(message: string | object, ...data: unknown[]): void {
    Logger.write(LogLevel.Debug, message, data);
  }

  public static info(message: string | object, ...data: unknown[]): void {
    Logger.write(LogLevel.Info, message, data);
  }

  public static warn(message: string | object, ...data: unknown[]): void {
    Logger.write(LogLevel.Warn, message, data);
  }

  public static error(message: string | object, ...data: unknown[]): void {
    Logger.write(LogLevel.Error, message, data);
  }

  private static write(level: LogLevel, message: string | object, data: unknown[]): void {
    const minimum = levels.find((candidate) => candidate === process.env.LOG_LEVEL) ?? LogLevel.Info;
    if (levels.indexOf(level) < levels.indexOf(minimum)) return;

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
