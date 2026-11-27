/** REST errors can carry interaction tokens in URLs, bodies, messages and nested causes. */
export class FailureLog {
  public constructor(private readonly error: unknown) {}

  public write(operation: string): void {
    const details = [operation];
    if (this.error !== null && typeof this.error === "object") {
      if ("status" in this.error && Number.isSafeInteger(this.error.status)) details.push(`status=${this.error.status}`);
      if ("code" in this.error && Number.isSafeInteger(this.error.code)) details.push(`code=${this.error.code}`);
    }
    console.error(details.join(" "));
  }
}
