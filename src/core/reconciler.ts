import { DomainError, type ServerId, type SyncResult } from "../domain/index.ts";
import { QuotaShrink } from "./quota-shrink.ts";
import type { ReconcileStep } from "./reconcile-step.ts";
import { SourceSetMirror } from "./source-set-mirror.ts";
import { SyncReport } from "./sync-report.ts";
import type { SyncContext } from "./sync-context.ts";
import { TrendingFill } from "./trending-fill.ts";

/** Brings a Server's emojis in line with 7TV and the stored state. */
export class Reconciler {
  private readonly steps: ReadonlyArray<ReconcileStep>;

  public constructor(private readonly context: SyncContext) {
    this.steps = [new QuotaShrink(context), new SourceSetMirror(context), new TrendingFill(context)];
  }

  public async reconcile(server: ServerId): Promise<SyncResult> {
    const synced = await this.context.load(server);
    const report = new SyncReport();
    synced.state.beginProblemReview();
    try {
      for (const step of this.steps) report.merge(await step.run(synced));
      synced.state.endProblemReview(); // only a full run knows which problems are gone
    } catch (err) {
      // Stop at the first domain error (e.g. missing permission) but keep the state of what was done.
      if (!(err instanceof DomainError)) throw err;
      report.say(err.toFeedback().level, err.toFeedback().text);
    } finally {
      // Whatever was applied is persisted, even when an unexpected error propagates, so
      // emojis created in this run are not mistaken for hand-made ones on the next load.
      await this.context.store.save(server, synced.state);
    }
    return report.toResult();
  }
}
