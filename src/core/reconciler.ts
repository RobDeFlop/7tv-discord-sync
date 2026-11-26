import type { ServerId, SyncResult } from "../domain/index.ts";
import type { ReconcileStep } from "./reconcile-step.ts";
import { SourceSetMirror } from "./source-set-mirror.ts";
import { SyncReport } from "./sync-report.ts";
import type { SyncContext } from "./sync-context.ts";
import { TrendingFill } from "./trending-fill.ts";

/** Brings a Server's emojis in line with 7TV and the stored state. */
export class Reconciler {
  private readonly steps: ReadonlyArray<ReconcileStep>;

  public constructor(private readonly context: SyncContext) {
    this.steps = [new SourceSetMirror(context), new TrendingFill(context)];
  }

  public async reconcile(server: ServerId): Promise<SyncResult> {
    const synced = await this.context.load(server);
    const report = new SyncReport();
    for (const step of this.steps) report.merge(await step.run(synced));
    await this.context.store.save(server, synced.state);
    return report.toResult();
  }
}
