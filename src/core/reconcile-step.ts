import type { SyncedServer } from "./synced-server.ts";
import type { SyncReport } from "./sync-report.ts";

/** One stage of a reconcile, run in Precedence order. */
export abstract class ReconcileStep {
  public abstract run(synced: SyncedServer, report: SyncReport): Promise<void>;
}
