import type { ReconcileStep } from "./reconcile-step.ts";
import type { SyncedServer } from "./synced-server.ts";
import type { SyncReport } from "./sync-report.ts";

/** Brings a Server's emojis in line with 7TV and the stored state inside an active session. */
export class Reconciler {
  public constructor(private readonly steps: readonly ReconcileStep[]) {}

  public async reconcile(synced: SyncedServer, report: SyncReport): Promise<void> {
    synced.state.beginProblemReview();
    for (const step of this.steps) await step.run(synced, report);
    synced.state.endProblemReview(); // Only a full run knows which problems are gone.
  }
}
