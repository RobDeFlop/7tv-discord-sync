import {
  EmoteAddNameConflictError,
  EmoteAddPromotionUnavailableError,
  EmoteNamer,
  QuotaFullError,
  ServerQuotas,
  type ManagedEmote,
  type SevenTvEmote,
} from "../../domain/index.ts";
import type { SevenTvPort } from "../../ports/index.ts";
import type { SlotAllocator } from "../slot-allocator.ts";
import { ImageFailure } from "../image-failure.ts";
import { NameCollision } from "../name-collision.ts";
import type { SyncReport } from "../sync-report.ts";
import type { SyncedServer } from "../synced-server.ts";
import { Command } from "./command.ts";
import { PreparedEmotePromotion, type PreparedEmoteAdd, type PreparedEmoteUpload } from "./prepared-emote-add.ts";

/** Add a 7TV emote as a Requested Emote. */
export class AddEmoteCommand extends Command {
  public constructor(
    private readonly source: string | PreparedEmoteAdd,
    private readonly name: string | undefined,
    private readonly sevenTv: SevenTvPort,
    private readonly allocator: SlotAllocator,
  ) {
    super();
  }

  public override async execute(synced: SyncedServer, report: SyncReport): Promise<void> {
    const { source } = this;
    const emote = typeof source === "string" ? await this.sevenTv.resolveEmoteLink(source) : source.emote;
    const existing = synced.state.findManaged(emote.id);
    if (source instanceof PreparedEmotePromotion) {
      if (!existing || existing.discordEmojiId !== source.discordEmojiId) throw new EmoteAddPromotionUnavailableError();
      return this.promote(synced, report, emote, existing);
    }
    if (existing) return this.promote(synced, report, emote, existing);
    return this.addNew(synced, report, emote, source);
  }

  /** Already managed: an explicit request promotes it to Requested and applies the requested name. */
  private async promote(synced: SyncedServer, report: SyncReport, emote: SevenTvEmote, existing: ManagedEmote): Promise<void> {
    const { state } = synced;
    const emoji = synced.emojiOf(existing);
    const wanted = this.name ? EmoteNamer.unique(this.name, synced.emojiNamesExcept(emoji.id)) : undefined;
    if (typeof this.source !== "string") {
      if (this.name && wanted?.suffixed) throw EmoteAddNameConflictError.taken(this.name);
      if (!this.name && emoji.name !== this.source.defaultName) throw EmoteAddNameConflictError.changed();
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
    if (existing.tier !== "requested") {
      existing.promoteTo("requested");
      state.addRequestedEmote({ sevenTvEmoteId: emote.id, requestedName: this.name });
      report.say("info", `${name} is now a Requested Emote.`);
    } else if (report.toResult().feedback.length === 0) report.say("info", `${name} is already on this Server.`);
  }

  private async addNew(
    synced: SyncedServer,
    report: SyncReport,
    emote: SevenTvEmote,
    source: string | PreparedEmoteUpload,
  ): Promise<void> {
    const { state } = synced;
    const quota = ServerQuotas.quotaOf(emote.animated);
    const result = typeof source === "string"
      ? await this.sevenTv.downloadImage(emote.id)
      : { ok: true as const, image: source.uploadImage };
    if (!result.ok) {
      const failure = new ImageFailure(emote, result.reason);
      state.recordProblem(failure.toProblem());
      return report.say("error", failure.text);
    }

    const plan = await this.allocator.plan(synced, quota, "requested");
    if (!plan.ok) throw new QuotaFullError(quota, emote.name);

    const requestedName = this.name ?? (typeof source === "string" ? undefined : source.defaultName);
    const wanted = requestedName ?? emote.name;
    if (typeof source !== "string" && this.allocator.placementName(synced, wanted, plan.displace).suffixed) {
      throw EmoteAddNameConflictError.taken(wanted);
    }

    const placed = await this.allocator.place(synced, report, plan, emote, result.image, "requested", wanted);
    state.addRequestedEmote({ sevenTvEmoteId: emote.id, requestedName });
    if (placed.suffixed) {
      const collision = NameCollision.onAdd(wanted, placed.name, emote.id);
      collision.record(state);
      report.say("warning", collision.text);
    } else {
      report.say("info", `Added ${placed.name}.`);
    }
  }
}
