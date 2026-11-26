import type { SyncResult } from "../domain/index.ts";
import type { SyncContext } from "./sync-context.ts";
import type { SyncedServer } from "./synced-server.ts";

/** One stage of a reconcile, run in Precedence order (Source Set, later Trending Fill). */
export abstract class ReconcileStep {
  public constructor(protected readonly context: SyncContext) {}

  public abstract run(synced: SyncedServer): Promise<SyncResult>;
}
