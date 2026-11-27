/** Writes operational messages without logging raw errors or requests. */
export class Logger {
  public constructor(private readonly output: Pick<typeof console, "log" | "error"> = console) {}

  public info(message: string): void {
    this.output.log(message);
  }

  public error(operation: string, error: unknown): void {
    // REST errors may contain tokens. Only include safe integer diagnostics.
    const status = error !== null && typeof error === "object" && "status" in error ? error.status : undefined;
    const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
    const statusDetail = Number.isSafeInteger(status) ? ` status=${status}` : "";
    const codeDetail = Number.isSafeInteger(code) ? ` code=${code}` : "";
    this.output.error(`${operation}${statusDetail}${codeDetail}`);
  }
}

export const logger = new Logger();
