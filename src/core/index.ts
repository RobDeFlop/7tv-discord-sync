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

  /**
   * Mirror the linked user's active set: remove what left it (never Requested
   * Emotes), rename what was renamed, add what is new in set order, and record
   * what does not fit as pending.
   */
  async function mirrorSourceSet(server: ServerId, state: ServerState, emojis: DiscordEmoji[]): Promise<SyncResult> {
    const changes: Change[] = [];
    const feedback: FeedbackMessage[] = [];
    const hadPending = new Set(state.problems.filter((p) => p.kind === "pending").map((p) => p.sevenTvEmoteId));
    state.problems = state.problems.filter((p) => p.kind !== "pending");
    if (!state.linkedUserId) return { changes, feedback };

    const user = await sevenTv.getUser(state.linkedUserId);
    if (!user) {
      feedback.push({ level: "warning", text: "The linked 7TV user could not be found; the Source Set was not synced." });
      return { changes, feedback };
    }
    const set = user.activeSetId ? await sevenTv.getSet(user.activeSetId) : null;
    const wanted = (set?.emotes ?? []).filter((e, i, all) => all.findIndex((o) => o.id === e.id) === i);
    const wantedIds = new Set(wanted.map((e) => e.id));

    const emojiOf = (m: ServerState["managedEmotes"][number]) => emojis.find((e) => e.id === m.discordEmojiId)!;

    // Removals: Source Set emotes that left the set. Requested Emotes stay.
    for (const m of [...state.managedEmotes]) {
      if (m.tier !== "source" || wantedIds.has(m.sevenTvEmoteId)) continue;
      const emoji = emojiOf(m);
      await discord.deleteEmoji(server, emoji.id);
      state.managedEmotes = state.managedEmotes.filter((x) => x !== m);
      emojis = emojis.filter((e) => e.id !== emoji.id);
      changes.push({ type: "deleted", name: emoji.name, reason: "removed" });
    }

    // Renames and promotion of Trending Fill emotes that joined the set.
    for (const emote of wanted) {
      const m = state.managedEmotes.find((x) => x.sevenTvEmoteId === emote.id);
      if (!m) continue;
      if (m.tier === "trending") m.tier = "source";
      if (m.tier !== "source") continue;
      const emoji = emojiOf(m);
      const taken = emojis.filter((e) => e.id !== emoji.id).map((e) => e.name);
      const { name } = uniqueName(emote.name, taken);
      if (name !== emoji.name) {
        await discord.renameEmoji(server, emoji.id, name);
        emojis = emojis.map((e) => (e.id === emoji.id ? { ...e, name } : e));
        changes.push({ type: "renamed", from: emoji.name, to: name });
      }
    }

    // Additions, in set order so the left-out emotes are deterministic.
    const pending: typeof wanted = [];
    for (const emote of wanted) {
      if (state.managedEmotes.some((x) => x.sevenTvEmoteId === emote.id)) continue;
      const quota = quotaOf(emote.animated);
      const quotas = await discord.getQuotas(server);
      const plan = planSlot(state, emojis, quotas.limits[quota], quota, "source");
      if (!plan.ok) {
        pending.push(emote);
        continue;
      }
      const image = await sevenTv.downloadImage(emote.id);
      if (!image.ok) {
        const text =
          image.reason === "too-large"
            ? `${emote.name} is still over 256 KB after conversion and was skipped.`
            : `${emote.name} could not be downloaded from 7TV.`;
        const kind = image.reason === "too-large" ? "too-large" : "skipped";
        const known = state.problems.some((p) => p.kind === kind && p.sevenTvEmoteId === emote.id);
        recordProblem(state, { kind, message: text, sevenTvEmoteId: emote.id });
        if (!known) feedback.push({ level: "warning", text });
        continue;
      }
      if (plan.displace) {
        const victim = emojis.find((e) => e.id === plan.displace!.discordEmojiId)!;
        await discord.deleteEmoji(server, victim.id);
        state.managedEmotes = state.managedEmotes.filter((x) => x !== plan.displace);
        emojis = emojis.filter((e) => e.id !== victim.id);
        changes.push({ type: "deleted", name: victim.name, reason: "displaced" });
        feedback.push({
          level: "warning",
          text: `${victim.name} (${plan.displace.tier}) was removed to make room for ${emote.name}.`,
        });
      }
      const { name, suffixed } = uniqueName(emote.name, emojis.map((e) => e.name));
      const created = await discord.createEmoji(server, { name, image: image.image });
      emojis = [...emojis, created];
      state.managedEmotes.push({ discordEmojiId: created.id, sevenTvEmoteId: emote.id, tier: "source", quota });
      changes.push({ type: "created", name, animated: emote.animated, sevenTvEmoteId: emote.id, tier: "source" });
      if (suffixed) {
        const text = `The name of ${emote.name} was taken, so it was added as ${name}.`;
        const known = state.problems.some((p) => p.kind === "renamed-with-suffix" && p.message === text);
        recordProblem(state, { kind: "renamed-with-suffix", message: text, sevenTvEmoteId: emote.id });
        if (!known) feedback.push({ level: "warning", text });
      }
    }

    for (const emote of pending) {
      state.problems.push({
        kind: "pending",
        message: `${emote.name} is waiting for a free ${quotaOf(emote.animated)} slot.`,
        sevenTvEmoteId: emote.id,
      });
    }
    const fresh = pending.filter((e) => !hadPending.has(e.id));
    if (fresh.length > 0) {
      feedback.push({
        level: "warning",
        text: `No free slot for ${fresh.map((e) => e.name).join(", ")}; they will be added when slots free up.`,
      });
    }
    return { changes, feedback };
  }

  async function link(server: ServerId, text: string): Promise<SyncResult> {
    let user;
    try {
      user = await sevenTv.resolveUserLink(text);
    } catch (err) {
      if (err instanceof InvalidLinkError) {
        return {
          changes: [],
          feedback: [
            { level: "error", text: `"${text}" is not a valid 7TV user link. Use a link like https://7tv.app/users/<id>.` },
          ],
        };
      }
      throw err;
    }
    const state = await store.load(server);
    state.linkedUserId = user.id;
    await store.save(server, state);
    const result = await reconcile(server);
    return { changes: result.changes, feedback: [{ level: "info", text: `Linked ${user.username}.` }, ...result.feedback] };
  }

  async function unlink(server: ServerId, keepEmotes: boolean): Promise<SyncResult> {
    const { state, emojis } = await loadSynced(server);
    if (!state.linkedUserId) {
      return { changes: [], feedback: [{ level: "error", text: "No 7TV user is linked to this Server." }] };
    }
    const changes: Change[] = [];
    const sourced = state.managedEmotes.filter((m) => m.tier === "source");
    for (const m of sourced) {
      const emoji = emojis.find((e) => e.id === m.discordEmojiId)!;
      if (keepEmotes) {
        changes.push({ type: "reserved", name: emoji.name });
      } else {
        await discord.deleteEmoji(server, emoji.id);
        changes.push({ type: "deleted", name: emoji.name, reason: "unlinked" });
      }
    }
    // Kept emotes simply stop being Managed Emotes; ownership sync makes them Reserved Slots.
    state.managedEmotes = state.managedEmotes.filter((m) => m.tier !== "source");
    state.linkedUserId = null;
    state.problems = state.problems.filter((p) => p.kind !== "pending");
    await store.save(server, state);
    const text = keepEmotes
      ? `Unlinked. ${sourced.length} emotes were kept as Reserved Slots.`
      : `Unlinked. ${sourced.length} emotes were deleted.`;
    return { changes, feedback: [{ level: "info", text }] };
  }

  async function reconcile(server: ServerId): Promise<SyncResult> {
    const { state, emojis } = await loadSynced(server);
    const result = await mirrorSourceSet(server, state, emojis);
    await store.save(server, state);
    return result;
  }

  return {
    async apply(server, command) {
      switch (command.type) {
        case "link":
          return link(server, command.link);
        case "unlink":
          return unlink(server, command.keepEmotes);
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

    reconcile,

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
