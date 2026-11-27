import { FailureLog } from "./failure-log.ts";

/** Writes operational messages without logging raw errors or requests. */
export class Logger {
  public constructor(private readonly output: Pick<typeof console, "log" | "error"> = console) {}

  public info(message: string): void {
    this.output.log(message);
  }

  public error(operation: string, error: unknown): void {
    this.output.error(new FailureLog(error).format(operation));
  }
}

export const logger = new Logger();
