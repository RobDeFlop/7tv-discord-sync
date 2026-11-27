import type { Change, FeedbackMessage, SyncResult } from "../domain/index.ts";

/** Collects what a command or reconcile step did and tells the admin. */
export class SyncReport {
  private readonly changes: Change[] = [];
  private readonly feedback: FeedbackMessage[] = [];

  public static single(level: FeedbackMessage["level"], text: string): SyncResult {
    return { changes: [], feedback: [{ level, text }] };
  }

  public change(change: Change): void {
    this.changes.push(change);
  }

  public say(level: FeedbackMessage["level"], text: string, reason?: FeedbackMessage["reason"]): void {
    this.feedback.push(reason ? { level, text, reason } : { level, text });
  }

  public merge(result: SyncResult): void {
    this.changes.push(...result.changes);
    this.feedback.push(...result.feedback);
  }

  public toResult(): SyncResult {
    return { changes: [...this.changes], feedback: [...this.feedback] };
  }
}
