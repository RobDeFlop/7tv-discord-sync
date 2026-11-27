import {
  EmoteAddNameConflictError,
  EmoteAddPromotionUnavailableError,
  QuotaFullError,
  type ManagedEmote,
  type SevenTvEmote,
} from "../../domain/index.ts";
import type { SlotAcquisition } from "../slot-acquisition.ts";
import type { SyncReport } from "../sync-report.ts";
import type { SyncedServer } from "../synced-server.ts";
import { Command } from "./command.ts";
import { PreparedEmotePromotion, type PreparedEmoteAdd } from "./prepared-emote-add.ts";

/** Confirm a prepared Requested Emote add against live Discord state. */
export class AddEmoteCommand extends Command {
  public constructor(
    private readonly prepared: PreparedEmoteAdd,
    private readonly name: string | undefined,
    private readonly allocator: SlotAcquisition,
  ) {
    super();
  }

  public override async execute(synced: SyncedServer, report: SyncReport): Promise<void> {
    const { prepared } = this;
    const { emote } = prepared;
    const existing = synced.state.findManaged(emote.id);
    if (prepared instanceof PreparedEmotePromotion) {
      if (!existing || existing.discordEmojiId !== prepared.discordEmojiId) throw new EmoteAddPromotionUnavailableError();
      return this.promote(synced, report, emote, existing);
    }
    if (existing) return this.promote(synced, report, emote, existing);

    const approvedName = this.name ?? prepared.defaultName;
    const outcome = await this.allocator.acquire(synced, report, {
      emote,
      tier: "requested",
      approved: {
        image: prepared.uploadImage,
        approvedName,
        approvedDisplacement: prepared.approvedDisplacement,
        suffixedFrom: this.name === undefined && prepared.defaultNameWasSuffixed ? emote.name : undefined,
      },
    });
    switch (outcome.kind) {
      case "failed": throw outcome.error;
      case "pending": throw new QuotaFullError(outcome.quota, emote.name);
      case "placed":
        synced.state.addRequestedEmote({ sevenTvEmoteId: emote.id, requestedName: approvedName });
        report.say("info", `Added ${outcome.name}.`);
        break;
    }
  }

  /** Already managed: promote it to Requested and apply the approved name. */
  private async promote(synced: SyncedServer, report: SyncReport, emote: SevenTvEmote, existing: ManagedEmote): Promise<void> {
    const { state } = synced;
    const { name: liveName } = synced.emojiOf(existing);
    if (this.name === undefined && liveName !== this.prepared.defaultName) throw EmoteAddNameConflictError.changed();
    const name = this.name === undefined ? liveName : await this.allocator.rename(synced, report, existing, this.name, true);
    state.problemLedger.placed(emote.id);
    if (existing.tier !== "requested") {
      existing.promoteTo("requested");
      state.addRequestedEmote({ sevenTvEmoteId: emote.id, requestedName: this.name });
      report.say("info", `${name} is now a Requested Emote.`);
    } else report.say("info", `${name} is already on this Server.`);
  }
}
