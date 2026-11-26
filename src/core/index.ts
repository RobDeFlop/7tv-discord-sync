import type {
  Change,
  Command,
  DiscordEmoji,
  FeedbackMessage,
  ServerId,
  ServerState,
  ServerStatus,
  SyncResult,
  Quota,
  Tier,
  TierUsage,
} from "../domain/index.ts";
import { uniqueName } from "../domain/names.ts";
import { InvalidLinkError } from "../ports/index.ts";
import type { DiscordPort, SevenTvPort, StorePort } from "../ports/index.ts";
import { planSlot, quotaOf } from "./slots.ts";

export interface SyncCoreDeps {
  sevenTv: SevenTvPort;
  discord: DiscordPort;
  store: StorePort;
}

/** The sync core's public interface. */
export interface SyncCore {
  /** Apply an admin command to a Server. */
  apply(server: ServerId, command: Command): Promise<SyncResult>;
  /** Bring a Server's emojis in line with 7TV and the stored state. */
  reconcile(server: ServerId): Promise<SyncResult>;
  /** Used/free slots per quota and tier, plus problems. */
  status(server: ServerId): Promise<ServerStatus>;
}

/**
 * Register every emoji the bot did not create as a Reserved Slot, and forget
 * Managed Emotes that were deleted by hand (freeing their slot).
 */
function syncOwnership(state: ServerState, emojis: DiscordEmoji[]): void {
  const present = new Set(emojis.map((e) => e.id));
  state.managedEmotes = state.managedEmotes.filter((m) => present.has(m.discordEmojiId));
  const managed = new Set(state.managedEmotes.map((m) => m.discordEmojiId));
  state.reservedSlots = emojis
    .filter((e) => !managed.has(e.id))
    .map((e) => ({ discordEmojiId: e.id, quota: quotaOf(e.animated) }));
}

function recordProblem(state: ServerState, problem: ServerState["problems"][number]): void {
  const dup = state.problems.some(
    (p) => p.kind === problem.kind && p.sevenTvEmoteId === problem.sevenTvEmoteId && p.message === problem.message,
  );
  if (!dup) state.problems.push(problem);
}

export function createSyncCore(deps: SyncCoreDeps): SyncCore {
  const { sevenTv, discord, store } = deps;

  async function loadSynced(server: ServerId) {
    const state = await store.load(server);
    const emojis = await discord.listEmojis(server);
    syncOwnership(state, emojis);
    return { state, emojis };
  }

  async function add(server: ServerId, command: Extract<Command, { type: "add" }>): Promise<SyncResult> {
    const changes: Change[] = [];
    const feedback: FeedbackMessage[] = [];
    const fail = (text: string): SyncResult => ({ changes, feedback: [...feedback, { level: "error", text }] });

    let emote;
    try {
      emote = await sevenTv.resolveEmoteLink(command.link);
    } catch (err) {
      if (err instanceof InvalidLinkError) {
        return fail(
          `"${command.link}" is not a valid 7TV emote link. Use a link like https://7tv.app/emotes/<id>.`,
        );
      }
      throw err;
    }

    const { state, emojis } = await loadSynced(server);
    const quota = quotaOf(emote.animated);

    // Already managed: an explicit request promotes it to Requested.
    const existing = state.managedEmotes.find((m) => m.sevenTvEmoteId === emote.id);
    if (existing) {
      const name = emojis.find((e) => e.id === existing.discordEmojiId)!.name;
      if (existing.tier !== "requested") {
        existing.tier = "requested";
        state.requestedEmotes.push({ sevenTvEmoteId: emote.id, requestedName: command.name });
        await store.save(server, state);
        return { changes, feedback: [{ level: "info", text: `${name} is now a Requested Emote.` }] };
      }
      return { changes, feedback: [{ level: "info", text: `${name} is already on this Server.` }] };
    }

    const image = await sevenTv.downloadImage(emote.id);
    if (!image.ok) {
      const text =
        image.reason === "too-large"
          ? `${emote.name} is still over 256 KB after conversion and was skipped.`
          : `${emote.name} could not be downloaded from 7TV.`;
      recordProblem(state, {
        kind: image.reason === "too-large" ? "too-large" : "skipped",
        message: text,
        sevenTvEmoteId: emote.id,
      });
      await store.save(server, state);
      return fail(text);
    }

    const quotas = await discord.getQuotas(server);
    const plan = planSlot(state, emojis, quotas.limits[quota], quota, "requested");
    if (!plan.ok) {
      return fail(
        `No free ${quota} slot for ${emote.name}: only Reserved Slots and Requested Emotes are left. Remove an emoji to make room.`,
      );
    }
    let taken = emojis.map((e) => e.name);
    if (plan.displace) {
      const victimEmoji = emojis.find((e) => e.id === plan.displace!.discordEmojiId)!;
      await discord.deleteEmoji(server, victimEmoji.id);
      state.managedEmotes = state.managedEmotes.filter((m) => m !== plan.displace);
      taken = taken.filter((n) => n !== victimEmoji.name);
      changes.push({ type: "deleted", name: victimEmoji.name, reason: "displaced" });
      feedback.push({
        level: "warning",
        text: `${victimEmoji.name} (${plan.displace.tier}) was removed to make room for ${emote.name}.`,
      });
    }

    const { name, suffixed } = uniqueName(command.name ?? emote.name, taken);
    const created = await discord.createEmoji(server, { name, image: image.image });
    state.managedEmotes.push({
      discordEmojiId: created.id,
      sevenTvEmoteId: emote.id,
      tier: "requested",
      quota,
    });
    state.requestedEmotes.push({ sevenTvEmoteId: emote.id, requestedName: command.name });
    changes.push({
      type: "created",
      name,
      animated: emote.animated,
      sevenTvEmoteId: emote.id,
      tier: "requested",
    });
    if (suffixed) {
      const text = `The name was taken, so the emote was added as ${name}.`;
      recordProblem(state, { kind: "renamed-with-suffix", message: text, sevenTvEmoteId: emote.id });
      feedback.push({ level: "warning", text });
    } else {
      feedback.push({ level: "info", text: `Added ${name}.` });
    }
    await store.save(server, state);
    return { changes, feedback };
  }

  async function remove(server: ServerId, name: string): Promise<SyncResult> {
    const { state, emojis } = await loadSynced(server);
    const emoji = emojis.find((e) => e.name === name);
    if (!emoji) return { changes: [], feedback: [{ level: "error", text: `No emoji named ${name} on this Server.` }] };
    const managed = state.managedEmotes.find((m) => m.discordEmojiId === emoji.id);
    if (!managed) {
      return {
        changes: [],
        feedback: [{ level: "error", text: `${name} was not created by this bot, so it cannot be removed here.` }],
      };
    }
    await discord.deleteEmoji(server, emoji.id);
    state.managedEmotes = state.managedEmotes.filter((m) => m !== managed);
    if (managed.tier === "requested") {
      state.requestedEmotes = state.requestedEmotes.filter((r) => r.sevenTvEmoteId !== managed.sevenTvEmoteId);
    }
    await store.save(server, state);
    return {
      changes: [{ type: "deleted", name, reason: "removed" }],
      feedback: [{ level: "info", text: `Removed ${name}.` }],
    };
  }

  return {
    async apply(server, command) {
      switch (command.type) {
        case "config": {
          const state = await store.load(server);
          await store.save(server, { ...state, logChannelId: command.logChannelId });
          return { changes: [], feedback: [{ level: "info", text: "Log channel updated." }] };
        }
        case "add":
          return add(server, command);
        case "remove":
          return remove(server, command.name);
        default:
          return {
            changes: [],
            feedback: [{ level: "error", text: `Command "${command.type}" is not implemented yet.` }],
          };
      }
    },

    async reconcile(server) {
      const { state } = await loadSynced(server);
      await store.save(server, state);
      return { changes: [], feedback: [] };
    },

    async status(server) {
      const { state, emojis } = await loadSynced(server);
      const quotas = await discord.getQuotas(server);
      const tierOf = new Map(state.managedEmotes.map((m) => [m.discordEmojiId, m.tier as Tier]));
      const usage = (quota: Quota): TierUsage => {
        const inQuota = emojis.filter((e) => quotaOf(e.animated) === quota);
        const byTier: Record<Tier, number> = { reserved: 0, requested: 0, source: 0, trending: 0 };
        for (const e of inQuota) byTier[tierOf.get(e.id) ?? "reserved"]++;
        return {
          used: inQuota.length,
          free: Math.max(0, quotas.limits[quota] - inQuota.length),
          byTier,
        };
      };
      return {
        quotas: { static: usage("static"), animated: usage("animated") },
        problems: state.problems,
        logChannelId: state.logChannelId,
        linkedUserId: state.linkedUserId,
        trending: state.trending,
      };
    },
  };
}
