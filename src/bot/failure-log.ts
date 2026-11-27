/** REST errors can carry interaction tokens in URLs, bodies, messages and nested causes. */
export class FailureLog {
  public constructor(private readonly error: unknown) {}

  public format(operation: string): string {
    if (this.error === null || typeof this.error !== "object") return operation;

    const status = "status" in this.error ? this.error.status : undefined;
    const code = "code" in this.error ? this.error.code : undefined;
    const statusDetail = Number.isSafeInteger(status) ? ` status=${status}` : "";
    const codeDetail = Number.isSafeInteger(code) ? ` code=${code}` : "";
    return `${operation}${statusDetail}${codeDetail}`;
  }
}
