import {
  DomainError,
  ServerQuotas,
  type EmojiImage,
  type FeedbackMessage,
  type SevenTvEmote,
  type ServerId,
  type ServerStatus,
  type SyncResult,
  type Tier,
  type TierUsage,
  type Quota,
} from "../domain/index.ts";
import type { DiscordPort, SevenTvPort, StorePort } from "../ports/index.ts";
import { AddEmoteCommand } from "./commands/add-emote-command.ts";
import { RemoveEmoteCommand } from "./commands/remove-emote-command.ts";
import { LinkSourceSetCommand } from "./commands/link-source-set-command.ts";
import type { Command } from "./commands/command.ts";
import { PreparedEmotePromotion, PreparedEmoteUpload, type PreparedEmoteAdd } from "./commands/prepared-emote-add.ts";
import { ImageFailure } from "./image-failure.ts";
import { QuotaShrink } from "./quota-shrink.ts";
import { Reconciler } from "./reconciler.ts";
import { ServerLock } from "./server-lock.ts";
import { ServerSession } from "./server-session.ts";
import { SlotAllocator } from "./slot-allocator.ts";
import { SourceSetMirror } from "./source-set-mirror.ts";
import { TrendingFill } from "./trending-fill.ts";
import type { SyncedServer } from "./synced-server.ts";

export * from "./commands/index.ts";

export type EmoteAddPreparation =
  | ({ emote: SevenTvEmote; previewImage: EmojiImage } & (
    | { prepared: PreparedEmoteAdd; slotNotice?: string }
    | { importFailure: "too-large" }
  ))
  | { feedback: FeedbackMessage };

/** The sync core's public interface. */
export class SyncCore {
  private readonly session: ServerSession;
  private readonly allocator = new SlotAllocator();
  private readonly reconciler: Reconciler;

  public constructor(private readonly sevenTv: SevenTvPort, private readonly discord: DiscordPort, store: StorePort) {
    this.session = new ServerSession(discord, store, new ServerLock());
    this.reconciler = new Reconciler([
      new QuotaShrink(), new SourceSetMirror(sevenTv, this.allocator), new TrendingFill(sevenTv, this.allocator),
    ]);
  }

  /** Validate a link before accepting a background sync; this does not mutate Server state. */
  public async prepareSourceLink(link: string): Promise<LinkSourceSetCommand> {
    return new LinkSourceSetCommand(await this.sevenTv.resolveUserLink(link));
  }

  /** Prepare an emote preview without saving state or changing any Discord emojis. */
  public async prepareEmoteAdd(server: ServerId, link: string): Promise<EmoteAddPreparation> {
    return this.prepareResolvedEmote(server, await this.sevenTv.resolveEmoteLink(link));
  }

  public async prepareEmoteSearch(server: ServerId, name: string): Promise<EmoteAddPreparation> {
    let emote: SevenTvEmote | null;
    try {
      emote = await this.sevenTv.findEmoteByExactName(name);
    } catch {
      return { feedback: { level: "error", text: "Could not search 7TV. Try again in a moment." } };
    }
    if (!emote) return { feedback: { level: "info", text: "No exact emote name matched your search on 7TV." } };
    return this.prepareResolvedEmote(server, emote);
  }

  private async prepareResolvedEmote(server: ServerId, emote: SevenTvEmote): Promise<EmoteAddPreparation> {
    const synced = await this.session.load(server);
    const managed = synced.state.findManaged(emote.id);
    const existing = managed ? synced.emojiOf(managed) : undefined;
    const result = await this.sevenTv.downloadImage(emote.id).catch((error: unknown) => {
      if (!existing) throw error;
      return { ok: false, reason: "unavailable" } as const;
    });
    if (!result.ok) {
      if (existing) {
        const previewImage = await this.discord.downloadEmojiImage(server, existing);
        if (previewImage) return {
          emote,
          previewImage,
          prepared: new PreparedEmotePromotion(emote, existing.name, existing.id),
        };
      }
      if ("previewImage" in result) {
        return { emote, previewImage: result.previewImage, importFailure: result.reason };
      }
      return { feedback: { level: "error", text: `Could not preview this emote. ${new ImageFailure(emote, result.reason).text}` } };
    }

    let slotNotice: string | undefined;
    let defaultName = existing?.name;
    if (defaultName === undefined) {
      const quota = ServerQuotas.quotaOf(emote.animated);
      const plan = await this.allocator.plan(synced, quota, "requested");
      if (!plan.ok) slotNotice = `The ${quota} quota is full. No Managed Emote is eligible for displacement.`;
      else if (plan.displace) slotNotice = `The ${quota} quota is full. Adding this emote could remove a lower-precedence Managed Emote.`;
      defaultName = this.allocator.placementName(synced, emote.name, plan.ok ? plan.displace : null).name;
    }
    const prepared = new PreparedEmoteUpload(emote, defaultName, result.image);
    return { emote, previewImage: prepared.uploadImage, prepared, slotNotice };
  }

  public async linkSourceSet(server: ServerId, link: string): Promise<SyncResult> {
    try {
      return await this.apply(server, await this.prepareSourceLink(link));
    } catch (error) {
      if (error instanceof DomainError) return { changes: [], feedback: [error.toFeedback()] };
      throw error;
    }
  }

  public addEmote(server: ServerId, source: string | PreparedEmoteAdd, name?: string): Promise<SyncResult> {
    return this.apply(server, new AddEmoteCommand(source, name, this.sevenTv, this.allocator));
  }

  public removeEmote(server: ServerId, name: string): Promise<SyncResult> {
    return this.apply(server, new RemoveEmoteCommand(name, this.sevenTv));
  }

  /** Apply an admin command to a Server. Domain errors come back as feedback. */
  public apply(server: ServerId, command: Command): Promise<SyncResult> {
    return this.session.run(server, async (synced, report) => {
      await command.execute(synced, report);
      if (command.requestsSync) await this.reconciler.reconcile(synced, report);
    });
  }

  /** Bring a Server's emojis in line with 7TV and the stored state. */
  public reconcile(server: ServerId): Promise<SyncResult> {
    return this.session.run(server, (synced, report) => this.reconciler.reconcile(synced, report));
  }

  /** Used/free slots per quota and tier, plus problems. */
  public async status(server: ServerId): Promise<ServerStatus> {
    const synced = await this.session.load(server);
    const quotas = await synced.quotas();
    const { state } = synced;
    return {
      manageExpressions: await this.discord.hasManageExpressions(server),
      writeQueue: this.discord.queueProgress(server),
      quotas: {
        static: this.usage(synced, "static", quotas),
        animated: this.usage(synced, "animated", quotas),
      },
      problems: [...state.problems],
      logChannelId: state.logChannelId,
      linkedUserId: state.linkedUserId,
      trending: { ...state.trending },
    };
  }

  private usage(synced: SyncedServer, quota: Quota, quotas: ServerQuotas): TierUsage {
    const tierOf = new Map<string, Tier>(synced.state.managedEmotes.map((m) => [m.discordEmojiId, m.tier]));
    const byTier: Record<Tier, number> = { reserved: 0, requested: 0, source: 0, trending: 0 };
    const inQuota = synced.emojisIn(quota);
    for (const e of inQuota) byTier[tierOf.get(e.id) ?? "reserved"]++;
    return {
      used: inQuota.length,
      free: Math.max(0, quotas.limit() - inQuota.length),
      byTier,
    };
  }
}
