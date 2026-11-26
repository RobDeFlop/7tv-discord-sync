import {
  DisplacementError,
  EmoteAddNameConflictError,
  EmoteAddPromotionUnavailableError,
  EmoteNamer,
  QuotaFullError,
  ServerQuotas,
  type EmojiImage,
  type ManagedEmote,
  type ServerId,
  type SevenTvEmote,
  type SyncResult,
} from "../../domain/index.ts";
import type { Placement } from "../slot-allocator.ts";
import { ImageFailure } from "../image-failure.ts";
import { NameCollision } from "../name-collision.ts";
import { SyncReport } from "../sync-report.ts";
import type { SyncContext } from "../sync-context.ts";
import type { SyncedServer } from "../synced-server.ts";
import { Command } from "./command.ts";

export type PreparedEmoteAdd = {
  emote: SevenTvEmote;
  defaultName: string;
} & (
  | { intent: "seven-tv-upload"; uploadImage: EmojiImage }
  | { intent: "promotion-only" }
);

/** Add a 7TV emote as a Requested Emote. */
export class AddEmoteCommand extends Command {
  private readonly source: string | PreparedEmoteAdd;

  public constructor(source: string | PreparedEmoteAdd, private readonly name?: string) {
    super();
    if (typeof source === "string") {
      this.source = source;
    } else {
      const prepared = { emote: { ...source.emote }, defaultName: source.defaultName };
      this.source = source.intent === "promotion-only" ? { ...prepared, intent: source.intent } : {
        ...prepared,
        intent: source.intent,
        uploadImage: { animated: source.uploadImage.animated, bytes: new Uint8Array(source.uploadImage.bytes) },
      };
    }
  }

  public async execute(server: ServerId, context: SyncContext): Promise<SyncResult> {
    const { source } = this;
    const emote = typeof source === "string" ? await context.sevenTv.resolveEmoteLink(source) : source.emote;
    const synced = await context.load(server);
    try {
      const existing = synced.state.findManaged(emote.id);
      if (existing) return await this.promote(synced, emote, existing);
      if (typeof source !== "string" && source.intent === "promotion-only") throw new EmoteAddPromotionUnavailableError();
      return await this.addNew(context, synced, emote, source);
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
    const wanted = this.name ? EmoteNamer.unique(this.name, synced.emojiNamesExcept(emoji.id)) : undefined;
    if (typeof this.source !== "string") {
      if (this.name && wanted?.suffixed) throw EmoteAddNameConflictError.taken(this.name);
      if (!this.name && emoji.name !== this.source.defaultName) throw EmoteAddNameConflictError.changed();
    }

    const promoted = existing.tier !== "requested";
    if (promoted) {
      existing.promoteTo("requested");
      state.addRequestedEmote({ sevenTvEmoteId: emote.id, requestedName: this.name });
    }
    let name = emoji.name;
    if (this.name && wanted) {
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

  private async addNew(
    context: SyncContext,
    synced: SyncedServer,
    emote: SevenTvEmote,
    source: string | Extract<PreparedEmoteAdd, { intent: "seven-tv-upload" }>,
  ): Promise<SyncResult> {
    const { state } = synced;
    const quota = ServerQuotas.quotaOf(emote.animated);
    const result = typeof source === "string"
      ? await context.sevenTv.downloadImage(emote.id)
      : { ok: true as const, image: source.uploadImage };
    if (!result.ok) {
      const failure = new ImageFailure(emote, result.reason);
      state.recordProblem(failure.toProblem());
      return SyncReport.single("error", failure.text);
    }

    const plan = await context.allocator.plan(synced, quota, "requested");
    if (!plan.ok) throw new QuotaFullError(quota, emote.name);

    const requestedName = this.name ?? (typeof source === "string" ? undefined : source.defaultName);
    const wanted = requestedName ?? emote.name;
    if (typeof source !== "string" && context.allocator.placementName(synced, wanted, plan.displace).suffixed) {
      throw EmoteAddNameConflictError.taken(wanted);
    }

    const report = new SyncReport();
    let placed: Placement;
    try {
      placed = await context.allocator.place(synced, report, plan, emote, result.image, "requested", wanted);
    } catch (error) {
      if (!(error instanceof DisplacementError)) throw error;
      report.say("error", error.toFeedback().text);
      return report.toResult();
    }
    state.addRequestedEmote({ sevenTvEmoteId: emote.id, requestedName });
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
