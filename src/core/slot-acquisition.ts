import {
  DisplacementError,
  DomainError,
  EmoteAddNameConflictError,
  EmoteAddSlotChangedError,
  EmoteNamer,
  ManagedEmote,
  ServerQuotas,
  type DiscordEmojiId,
  type EmojiImage,
  type ManagedTier,
  type Problem,
  type Quota,
  type SevenTvEmote,
  type SevenTvEmoteId,
} from "../domain/index.ts";
import { RateLimitError, type ImageResult, type SevenTvPort } from "../ports/index.ts";
import type { SyncReport } from "./sync-report.ts";
import type { SyncedServer } from "./synced-server.ts";

type ImageFailureReason = Extract<ImageResult, { ok: false }>["reason"];

interface RequestedPlacement {
  image: EmojiImage;
  approvedName: string;
  approvedDisplacement: DiscordEmojiId | null;
  /** Original 7TV name if the admin approved a suffixed default. */
  suffixedFrom?: string;
}

type SlotRequest = { emote: SevenTvEmote } & (
  | { tier: "source" | "trending" }
  | { tier: "requested"; approved: RequestedPlacement }
);

type SlotOutcome =
  | { kind: "placed"; name: string }
  | { kind: "pending"; quota: Quota; fresh: boolean }
  | { kind: "skipped" }
  | { kind: "failed"; error: DomainError };

/** Owns how a missing emote acquires a Slot, including naming, images and failed Displacement recovery. */
export class SlotAcquisition {
  public constructor(private readonly sevenTv: SevenTvPort) {}

  /** Inspect, but never reserve, the Slot and name a Requested Emote would use. */
  public async preview(synced: SyncedServer, emote: SevenTvEmote) {
    const { quota, plan } = await this.plan(synced, emote, "requested");
    const victim = plan.ok ? plan.displace : null;
    const placement = SlotAcquisition.placementName(synced, emote.name, victim?.discordEmojiId);
    const notice = !plan.ok ? `The ${quota} quota is full. No Managed Emote is eligible for displacement.`
      : victim ? `The ${quota} quota is full. Adding this emote could remove a lower-precedence Managed Emote (${synced.emojiOf(victim).name}).`
      : undefined;
    return { ...placement, displace: victim?.discordEmojiId ?? null, notice };
  }

  /** Run in the active Server session. A failure outside the domain (including a rate limit) interrupts the run. */
  public async acquire(synced: SyncedServer, report: SyncReport, request: SlotRequest): Promise<SlotOutcome> {
    try {
      return await this.acquireSlot(synced, report, request);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return { kind: "failed", error };
    }
  }

  private async acquireSlot(synced: SyncedServer, report: SyncReport, request: SlotRequest): Promise<SlotOutcome> {
    const { emote, tier } = request;
    const ledger = synced.state.problemLedger;
    if (tier === "trending" && ledger.observeKnownImageFailure(emote.id)) return { kind: "skipped" };

    const { quota, plan } = await this.plan(synced, emote, tier);
    if (!plan.ok) {
      const fresh = tier === "source" && ledger.observeSourcePending(emote.id, `${emote.name} is waiting for a free ${quota} slot.`);
      return { kind: "pending", quota, fresh };
    }

    const approval = tier === "requested" ? request.approved : undefined;
    const wanted = approval?.approvedName ?? emote.name;
    const displace = plan.displace;
    const placement = SlotAcquisition.placementName(synced, wanted, displace?.discordEmojiId);
    if (approval && placement.suffixed) throw EmoteAddNameConflictError.taken(wanted);
    if (approval && displace && displace.discordEmojiId !== approval.approvedDisplacement) throw new EmoteAddSlotChangedError();

    const result: ImageResult = approval ? { ok: true, image: approval.image } : await this.sevenTv.downloadImage(emote.id);
    if (!result.ok) {
      const problem = SlotAcquisition.imageFailure(emote, result.reason);
      if (ledger.observe(problem)) report.say("warning", problem.message);
      return { kind: "skipped" };
    }

    const { name } = placement;
    const victim = displace ? await synced.removeManaged(displace, report, "displaced") : undefined;
    if (victim && displace) report.say("warning", `${victim.name} (${displace.tier}) was removed to make room for ${emote.name}.`);

    let created;
    try {
      created = await synced.createEmoji(name, result.image);
    } catch (cause) {
      if (!victim || !displace) throw cause;
      // An upload failure does not undo a Discord delete. Record the lost Managed Emote
      // before stopping, so the next sync can refill the freed Slot by Precedence.
      const error = new DisplacementError(name, victim.name, cause);
      ledger.observe({ kind: "pending", sevenTvEmoteId: displace.sevenTvEmoteId, message: error.message });
      if (cause instanceof RateLimitError) throw cause;
      throw error;
    }

    const suffixedFrom = placement.suffixed ? wanted : approval?.suffixedFrom;
    const problem = suffixedFrom === undefined ? undefined : `The name ${suffixedFrom} was taken, so the emote was added as ${name}.`;
    ledger.placed(emote.id);
    if (problem) SlotAcquisition.recordSuffix(synced, report, emote.id, problem);
    else ledger.renamedWithoutSuffix(emote.id);
    synced.state.addManagedEmote(new ManagedEmote(created.id, emote.id, tier, quota));
    report.change({ type: "created", name, animated: emote.animated, sevenTvEmoteId: emote.id, tier });
    return { kind: "placed", name };
  }

  /** Rename a Managed Emote, applying the same naming and suffix policy as acquisition. */
  public async rename(synced: SyncedServer, report: SyncReport, managed: ManagedEmote, wanted: string, exact = false): Promise<string> {
    const emoji = synced.emojiOf(managed);
    const { name, suffixed } = SlotAcquisition.placementName(synced, wanted, emoji.id);
    if (exact && suffixed) throw EmoteAddNameConflictError.taken(wanted);
    if (name === emoji.name) {
      if (!suffixed) synced.state.problemLedger.renamedWithoutSuffix(managed.sevenTvEmoteId);
      return name;
    }
    await synced.renameEmoji(emoji, name);
    report.change({ type: "renamed", from: emoji.name, to: name });
    if (suffixed) {
      SlotAcquisition.recordSuffix(synced, report, managed.sevenTvEmoteId, `The name ${wanted} was taken, so the emote was renamed to ${name}.`);
    } else {
      synced.state.problemLedger.renamedWithoutSuffix(managed.sevenTvEmoteId);
    }
    return name;
  }

  public static imageFailure(emote: SevenTvEmote, reason: ImageFailureReason): Problem {
    return reason === "too-large"
      ? { kind: "too-large", sevenTvEmoteId: emote.id, message: `${emote.name} is still over 256 KB after conversion and was skipped.` }
      : { kind: "skipped", sevenTvEmoteId: emote.id, message: `${emote.name} could not be downloaded from 7TV.` };
  }

  private async plan(synced: SyncedServer, emote: SevenTvEmote, tier: ManagedTier) {
    const quota = ServerQuotas.quotaOf(emote.animated);
    const quotas = await synced.quotas();
    return { quota, plan: synced.state.planSlot(quota, tier, synced.usedIn(quota), quotas.limit()) };
  }

  private static placementName(synced: SyncedServer, wanted: string, ignore?: DiscordEmojiId) {
    return EmoteNamer.unique(wanted, ignore === undefined ? synced.emojiNames() : synced.emojiNamesExcept(ignore));
  }

  private static recordSuffix(synced: SyncedServer, report: SyncReport, emoteId: SevenTvEmoteId, message: string): void {
    if (synced.state.problemLedger.observe({ kind: "renamed-with-suffix", sevenTvEmoteId: emoteId, message })) {
      report.say("warning", message);
    }
  }
}
