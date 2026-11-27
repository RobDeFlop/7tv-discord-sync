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

  private static minimum(): LogLevel {
    const configured = process.env.LOG_LEVEL?.toLowerCase() as keyof typeof LogLevel | undefined;
    return configured !== undefined && configured in LogLevel ? LogLevel[configured] : LogLevel.info;
  }
}