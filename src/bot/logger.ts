type ErrorDiagnostics = { status?: number; code?: number };

/** Writes operational messages without logging raw errors or requests. */
export class Logger {
  public constructor(private readonly output: Pick<typeof console, "log" | "error"> = console) {}

  public info(message: string): void {
    this.output.log(message);
  }

  /** REST errors may contain tokens. Copy only numeric diagnostics. */
  public static diagnostics(caught: unknown): ErrorDiagnostics | undefined {
    if (caught === null || typeof caught !== "object") return undefined;
    const diagnostics: ErrorDiagnostics = {};
    const status = "status" in caught ? caught.status : undefined;
    const code = "code" in caught ? caught.code : undefined;
    if (typeof status === "number") diagnostics.status = status;
    if (typeof code === "number") diagnostics.code = code;
    return diagnostics.status === undefined && diagnostics.code === undefined ? undefined : diagnostics;
  }

  public error(operation: string, error: ErrorDiagnostics | undefined): void {
    const { status, code } = error ?? {};
    const statusDetail = Number.isSafeInteger(status) ? ` status=${status}` : "";
    const codeDetail = Number.isSafeInteger(code) ? ` code=${code}` : "";
    this.output.error(`${operation}${statusDetail}${codeDetail}`);
  }
}

export const logger = new Logger();
