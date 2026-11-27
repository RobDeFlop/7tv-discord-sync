import {
  ServerQuotas,
  type EmojiImage,
  type FeedbackMessage,
  type SevenTvEmote,
  type SevenTvUserId,
  type ServerId,
  type ServerStatus,
  type SyncResult,
  type Tier,
  type TierUsage,
  type Quota,
} from "../domain/index.ts";
import { RateLimitError, type DiscordPort, type ImageResult, type SevenTvChange, type SevenTvPort, type StorePort } from "../ports/index.ts";
import { Logger, LogLevel } from "../logger.ts";
import { AddEmoteCommand } from "./commands/add-emote-command.ts";
import { RemoveEmoteCommand } from "./commands/remove-emote-command.ts";
import { LinkSourceSetCommand } from "./commands/link-source-set-command.ts";
import type { Command } from "./commands/command.ts";
import { PreparedEmotePromotion, PreparedEmoteUpload, type PreparedEmoteAdd } from "./commands/prepared-emote-add.ts";
import { QuotaShrink } from "./quota-shrink.ts";
import { Reconciler } from "./reconciler.ts";
import { ServerLock } from "./server-lock.ts";
import { ServerSession } from "./server-session.ts";
import { SlotAcquisition } from "./slot-acquisition.ts";
import { SourceSetMirror } from "./source-set-mirror.ts";
import { TrendingFill } from "./trending-fill.ts";
import { SyncReport } from "./sync-report.ts";
import { SyncScheduler, type SyncFailure, type SyncObserver } from "./sync-scheduler.ts";
import type { SyncedServer } from "./synced-server.ts";

export * from "./commands/index.ts";
export type { SyncObserver, SyncUpdate } from "./sync-scheduler.ts";

export type EmoteAddPreparation =
  | ({ emote: SevenTvEmote; previewImage: EmojiImage } & (
    | { prepared: PreparedEmoteAdd; slotNotice?: string }
    | { importFailure: "too-large" }
  ))
  | { feedback: FeedbackMessage };

export interface EmoteAddConfirmation extends SyncResult {
  feedback: (FeedbackMessage & { retry?: string })[];
}

/** The sync core's public interface. */
export class SyncCore {
  private readonly lock = new ServerLock();
  private readonly session: ServerSession;
  private readonly allocator: SlotAcquisition;
  private readonly scheduler: SyncScheduler;
  private readonly commandTasks = new Set<Promise<unknown>>();
  private readonly removals = new Map<ServerId, Promise<void>>();
  private stopping = false;

  public constructor(
    private readonly sevenTv: SevenTvPort,
    private readonly discord: DiscordPort,
    private readonly store: StorePort,
    onSyncFailure: SyncFailure = () => {},
  ) {
    this.session = new ServerSession(discord, store);
    this.allocator = new SlotAcquisition(sevenTv);
    const reconciler = new Reconciler([
      new QuotaShrink(), new SourceSetMirror(sevenTv, this.allocator), new TrendingFill(sevenTv, this.allocator),
    ]);
    this.scheduler = new SyncScheduler(this.lock, (server, report) =>
      this.session.run(server, report, (synced) => reconciler.reconcile(synced, report)), onSyncFailure);
  }

  /** Prepare an emote preview without saving state or changing any Discord emojis. */
  public async prepareEmoteAdd(server: ServerId, link: string): Promise<EmoteAddPreparation> {
    return this.prepareResolvedEmote(server, await this.sevenTv.resolveEmoteLink(link));
  }

  public async prepareEmoteSearch(server: ServerId, name: string): Promise<EmoteAddPreparation> {
    let emote: SevenTvEmote | null;
    try {
      emote = await this.sevenTv.findEmoteByExactName(name);
    } catch (error) {
      Logger.write(LogLevel.warn, `emote_search_unavailable operation=prepare_preview server=${Logger.field(server)} ${Logger.failure(error)}`);
      return { feedback: { level: "error", text: "Could not search 7TV. Try again in a moment." } };
    }
    if (!emote) return { feedback: { level: "info", text: "No exact emote name matched your search on 7TV." } };
    return this.prepareResolvedEmote(server, emote);
  }

  private async prepareResolvedEmote(server: ServerId, emote: SevenTvEmote): Promise<EmoteAddPreparation> {
    const synced = await this.session.load(server);
    const managed = synced.state.findManaged(emote.id);
    const existing = managed ? synced.emojiOf(managed) : undefined;
    const result = await this.sevenTv.downloadImage(emote.id).catch((error: unknown): ImageResult => {
      if (!existing) throw error;
      Logger.write(LogLevel.warn, `emote_image_fallback operation=prepare_preview server=${Logger.field(server)} emote=${Logger.field(emote.id)} ${Logger.failure(error)}`);
      return { ok: false, reason: "unavailable" };
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
      const { message } = SlotAcquisition.imageFailure(emote, result.reason);
      return { feedback: { level: "error", text: `Could not preview this emote. ${message}` } };
    }

    const slot = existing ? undefined : await this.allocator.preview(synced, emote);
    const defaultName = slot?.name ?? existing?.name ?? emote.name;
    const prepared = new PreparedEmoteUpload(emote, defaultName, result.image, slot?.displace, slot?.suffixed);
    return { emote, previewImage: prepared.uploadImage, prepared, slotNotice: slot?.notice };
  }

  public linkSourceSet(server: ServerId, link: string, observer?: SyncObserver): Promise<SyncResult> {
    return this.apply(server, new LinkSourceSetCommand(link, this.sevenTv), observer);
  }

  /** Confirm the exact preview or return typed feedback with retry guidance. */
  public async addEmote(server: ServerId, prepared: PreparedEmoteAdd, name?: string): Promise<EmoteAddConfirmation> {
    const result = await this.apply(server, new AddEmoteCommand(prepared, name, this.allocator));
    return {
      ...result,
      feedback: result.feedback.map((message) => {
        const retry = SyncCore.emoteAddRetry(message.reason);
        return retry ? { ...message, retry } : message;
      }),
    };
  }

  private static emoteAddRetry(reason: FeedbackMessage["reason"]): string | undefined {
    switch (reason) {
      case "emote-name-taken": return "and choose another name.";
      case "emote-name-changed": return "to review the name.";
      case "emote-promotion-unavailable": return "to start over.";
      case "emote-slot-changed": return "to review the slot.";
    }
  }

  public removeEmote(server: ServerId, name: string): Promise<SyncResult> {
    return this.apply(server, new RemoveEmoteCommand(name, this.sevenTv));
  }

  /**
   * Persist a Command and return its feedback. A setting requests a reconcile after saving.
   * With an observer, return after applying the setting and report sync pauses/results to that observer;
   * otherwise await the reconcile too. Unexpected Command errors reject; unexpected reconcile
   * failures are published as feedback to observers and thrown for callers without one.
   */
  public async apply(server: ServerId, command: Command, observer?: SyncObserver): Promise<SyncResult> {
    if (this.stopping || this.removals.has(server)) {
      const result = SyncCore.cancelledCommand();
      if (observer) await observer(server, { kind: "cancelled", result });
      return result;
    }
    const committed = this.lock.run(server, async () => {
      if (this.removals.has(server)) return { result: SyncCore.cancelledCommand(), cancelled: true };
      const report = new SyncReport();
      let applied = false;
      try {
        await this.session.run(server, report, async (synced) => {
          await command.execute(synced, report);
          applied = true;
        });
      } catch (error) {
        if (!(error instanceof RateLimitError)) throw error;
        if (this.removals.has(server)) return { result: SyncCore.cancelledCommand(), cancelled: true };
        const pause = this.scheduler.recover(server, error, report.toResult());
        report.say("warning", `Discord stopped this command before it finished. ${pause} Retry the command after sync resumes.`);
      }
      if (this.removals.has(server)) return { result: SyncCore.cancelledCommand(), cancelled: true };
      const result = report.toResult();
      const completion = applied && command.requestsSync
        ? this.scheduler.request(server, observer && ((target, update) => observer(target, update, result.feedback)))
        : undefined;
      return { result, completion };
    }).then(async ({ result, completion, cancelled }) => {
      if (!completion && observer) await observer(server, { kind: cancelled ? "cancelled" : "finished", result });
      return { result, completion };
    });
    this.commandTasks.add(committed);
    const remove = () => this.commandTasks.delete(committed);
    void committed.then(remove, remove);
    const { result, completion } = await committed;
    if (!completion || observer) return result;

    const done = await completion;
    if (done.error) throw done.error.cause;
    return { changes: done.result.changes, feedback: [...result.feedback, ...done.result.feedback] };
  }

  /**
   * Queue a reconcile and resolve when it finishes or is cancelled. An observer receives intermediate
   * retry notices and terminal feedback; unexpected failures reject only without an observer.
   */
  public async reconcile(
    server: ServerId,
    observer?: SyncObserver,
    trigger: "requested" | "automatic" = "requested",
  ): Promise<SyncResult> {
    const { result, error } = await this.scheduler.request(server, observer, trigger);
    if (error && !observer) throw error.cause;
    return result;
  }

  public storedServers(): Promise<ServerId[]> {
    return this.store.listServers();
  }

  public async serversFollowing(changes: readonly SevenTvChange[]): Promise<ServerId[]> {
    const users = new Set<SevenTvUserId>();
    let allLinked = false;
    for (const change of changes) {
      if (change.type === "active-set-switched") users.add(change.userId);
      else allLinked = true;
    }
    const targets: ServerId[] = [];
    for (const server of await this.storedServers()) {
      const linked = (await this.store.load(server)).linkedUserId;
      if (linked !== null && (allLinked || users.has(linked))) targets.push(server);
    }
    return targets;
  }

  public async logChannelId(server: ServerId): Promise<string | null> {
    return (await this.store.load(server)).logChannelId;
  }

  public removeServer(server: ServerId): Promise<void> {
    const running = this.removals.get(server);
    if (running) return running;
    this.scheduler.cancel(server);
    const removal = this.lock.run(server, () => this.store.remove(server))
      .finally(() => this.removals.delete(server));
    this.removals.set(server, removal);
    return removal;
  }

  private static cancelledCommand(): SyncResult {
    return SyncReport.single("warning", "Command cancelled because the bot left this Server or is stopping.");
  }

  public async syncIdle(): Promise<void> {
    while (this.commandTasks.size) await Promise.allSettled([...this.commandTasks]);
    await this.scheduler.idle();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    await this.scheduler.stop();
    await this.syncIdle();
  }

  /** Used/free slots per quota and tier, plus problems. */
  public async status(server: ServerId): Promise<ServerStatus> {
    const synced = await this.session.load(server);
    const quotas = await synced.quotas();
    const { state } = synced;
    const last = this.scheduler.lastUpdate(server);
    return {
      ...(last ? { lastSync: last } : {}),
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
