import {
  EmoteNamer,
  QuotaFullError,
  ServerQuotas,
  type ManagedEmote,
  type ServerId,
  type SevenTvEmote,
  type SyncResult,
} from "../../domain/index.ts";
import { ImageFailure } from "../image-failure.ts";
import { NameCollision } from "../name-collision.ts";
import { SyncReport } from "../sync-report.ts";
import type { SyncContext } from "../sync-context.ts";
import type { SyncedServer } from "../synced-server.ts";
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
    try {
      const existing = synced.state.findManaged(emote.id);
      return existing ? await this.promote(synced, emote, existing) : await this.addNew(context, synced, emote);
    } finally {
      // Persist whatever was applied, even when a write failed half-way.
      await context.store.save(server, synced.state);
    }
  }

  /** Already managed: an explicit request promotes it to Requested and applies the requested name. */
  private async promote(synced: SyncedServer, emote: SevenTvEmote, existing: ManagedEmote): Promise<SyncResult> {
    const { state } = synced;
    const report = new SyncReport();
    const emoji = synced.emojiOf(existing);
    const promoted = existing.tier !== "requested";
    if (promoted) {
      existing.promoteTo("requested");
      state.addRequestedEmote({ sevenTvEmoteId: emote.id, requestedName: this.name });
    }
    let name = emoji.name;
    if (this.name) {
      const wanted = EmoteNamer.unique(this.name, synced.emojiNamesExcept(emoji.id));
      if (wanted.name !== emoji.name) {
        await synced.renameEmoji(emoji, wanted.name);
        report.change({ type: "renamed", from: emoji.name, to: wanted.name });
        name = wanted.name;
      }
      if (wanted.suffixed) {
        const collision = NameCollision.onRename(this.name, wanted.name, emote.id);
        collision.record(state);
        report.say("warning", collision.text);
      }
    }
    if (promoted) report.say("info", `${name} is now a Requested Emote.`);
    else if (report.toResult().feedback.length === 0) report.say("info", `${name} is already on this Server.`);
    return report.toResult();
  }

  private async addNew(context: SyncContext, synced: SyncedServer, emote: SevenTvEmote): Promise<SyncResult> {
    const { state } = synced;
    const quota = ServerQuotas.quotaOf(emote.animated);
    const image = await context.sevenTv.downloadImage(emote.id);
    if (!image.ok) {
      const failure = new ImageFailure(emote, image.reason);
      state.recordProblem(failure.toProblem());
      return SyncReport.single("error", failure.text);
    }

    const plan = await context.allocator.plan(synced, quota, "requested");
    if (!plan.ok) throw new QuotaFullError(quota, emote.name);

    const report = new SyncReport();
    const wanted = this.name ?? emote.name;
    const placed = await context.allocator.place(synced, report, plan, emote, image.image, "requested", wanted);
    state.addRequestedEmote({ sevenTvEmoteId: emote.id, requestedName: this.name });
    if (placed.suffixed) {
      const collision = NameCollision.onAdd(wanted, placed.name, emote.id);
      collision.record(state);
      report.say("warning", collision.text);
    } else {
      report.say("info", `Added ${placed.name}.`);
    }
    return report.toResult();
  }
}
