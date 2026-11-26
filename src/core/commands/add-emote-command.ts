import { QuotaFullError, ServerQuotas, type ServerId, type SyncResult } from "../../domain/index.ts";
import { ImageFailure } from "../image-failure.ts";
import { SyncReport } from "../sync-report.ts";
import type { SyncContext } from "../sync-context.ts";
import { Command } from "./command.ts";

/** Add a 7TV emote as a Requested Emote. */
export class AddEmoteCommand extends Command {
  public constructor(
    private readonly link: string,
    private readonly name?: string,
  ) {
    super();
  }

  public async execute(server: ServerId, context: SyncContext): Promise<SyncResult> {
    const emote = await context.sevenTv.resolveEmoteLink(this.link);
    const synced = await context.load(server);
    const { state } = synced;
    const quota = ServerQuotas.quotaOf(emote.animated);

    // Already managed: an explicit request promotes it to Requested.
    const existing = state.findManaged(emote.id);
    if (existing) {
      const name = synced.emojiOf(existing).name;
      if (existing.tier !== "requested") {
        existing.promoteTo("requested");
        state.addRequestedEmote({ sevenTvEmoteId: emote.id, requestedName: this.name });
        await context.store.save(server, state);
        return SyncReport.single("info", `${name} is now a Requested Emote.`);
      }
      return SyncReport.single("info", `${name} is already on this Server.`);
    }

    const image = await context.sevenTv.downloadImage(emote.id);
    if (!image.ok) {
      const failure = new ImageFailure(emote, image.reason);
      state.recordProblem(failure.toProblem());
      await context.store.save(server, state);
      return SyncReport.single("error", failure.text);
    }

    const plan = await context.allocator.plan(synced, quota, "requested");
    if (!plan.ok) throw new QuotaFullError(quota, emote.name);

    const report = new SyncReport();
    const placed = await context.allocator.place(
      synced,
      report,
      plan,
      emote,
      image.image,
      "requested",
      this.name ?? emote.name,
    );
    state.addRequestedEmote({ sevenTvEmoteId: emote.id, requestedName: this.name });
    if (placed.suffixed) {
      const text = `The name was taken, so the emote was added as ${placed.name}.`;
      state.recordProblem({ kind: "renamed-with-suffix", message: text, sevenTvEmoteId: emote.id });
      report.say("warning", text);
    } else {
      report.say("info", `Added ${placed.name}.`);
    }
    await context.store.save(server, state);
    return report.toResult();
  }
}
