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
import { LinkSourceSetCommand } from "./commands/link-source-set-command.ts";
import type { Command } from "./commands/command.ts";
import { PreparedEmotePromotion, PreparedEmoteUpload, type PreparedEmoteAdd } from "./commands/prepared-emote-add.ts";
import { ImageFailure } from "./image-failure.ts";
import { SyncContext } from "./sync-context.ts";
import type { SyncedServer } from "./synced-server.ts";

export * from "./commands/index.ts";

type EmoteAddPreparation =
  | ({ emote: SevenTvEmote; previewImage: EmojiImage } & (
    | { prepared: PreparedEmoteAdd; slotNotice?: string }
    | { importFailure: "too-large" }
  ))
  | { feedback: FeedbackMessage };

/** The sync core's public interface. */
export class SyncCore {
  private readonly context: SyncContext;

  public constructor(sevenTv: SevenTvPort, discord: DiscordPort, store: StorePort) {
    this.context = new SyncContext(sevenTv, discord, store);
  }

  /** Validate a link before accepting a background sync; this does not mutate Server state. */
  public async prepareSourceLink(link: string): Promise<LinkSourceSetCommand> {
    return new LinkSourceSetCommand(await this.context.sevenTv.resolveUserLink(link));
  }

  /** Prepare an emote preview without saving state or changing any Discord emojis. */
  public async prepareEmoteAdd(server: ServerId, link: string): Promise<EmoteAddPreparation> {
    const emote = await this.context.sevenTv.resolveEmoteLink(link);
    const synced = await this.context.load(server);
    const managed = synced.state.findManaged(emote.id);
    const existing = managed ? synced.emojiOf(managed) : undefined;
    const result = await this.context.sevenTv.downloadImage(emote.id).catch((error: unknown) => {
      if (!existing) throw error;
      return { ok: false, reason: "unavailable" } as const;
    });
    if (!result.ok) {
      if (existing) {
        const previewImage = await this.context.discord.downloadEmojiImage(server, existing);
        if (previewImage) return {
          emote,
          previewImage,
          prepared: new PreparedEmotePromotion(emote, existing.name, existing.id),
        };
      }
      if (result.reason === "too-large") return { emote, previewImage: result.previewImage, importFailure: result.reason };
      return { feedback: { level: "error", text: `Could not preview this emote. ${new ImageFailure(emote, result.reason).text}` } };
    }

    let slotNotice: string | undefined;
    let defaultName = existing?.name;
    if (defaultName === undefined) {
      const quota = ServerQuotas.quotaOf(emote.animated);
      const plan = await this.context.allocator.plan(synced, quota, "requested");
      if (!plan.ok) slotNotice = `The ${quota} quota is full. No Managed Emote is eligible for displacement.`;
      else if (plan.displace) slotNotice = `The ${quota} quota is full. Adding this emote could remove a lower-precedence Managed Emote.`;
      defaultName = this.context.allocator.placementName(synced, emote.name, plan.ok ? plan.displace : null).name;
    }
    const prepared = new PreparedEmoteUpload(emote, defaultName, result.image);
    return { emote, previewImage: prepared.uploadImage, prepared, slotNotice };
  }

  /** Apply an admin command to a Server. Domain errors come back as feedback. */
  public async apply(server: ServerId, command: Command): Promise<SyncResult> {
    try {
      return await command.execute(server, this.context);
    } catch (err) {
      if (err instanceof DomainError) return { changes: [], feedback: [err.toFeedback()] };
      throw err;
    }
  }

  /** Bring a Server's emojis in line with 7TV and the stored state. */
  public reconcile(server: ServerId): Promise<SyncResult> {
    return this.context.reconciler.reconcile(server);
  }

  /** Used/free slots per quota and tier, plus problems. */
  public async status(server: ServerId): Promise<ServerStatus> {
    const synced = await this.context.load(server);
    const quotas = await synced.quotas();
    const { state } = synced;
    return {
      manageExpressions: await this.context.discord.hasManageExpressions(server),
      writeQueue: this.context.discord.queueProgress(server),
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
