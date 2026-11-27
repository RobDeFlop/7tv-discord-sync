import type { EmoteAddPreparation, PreparedEmoteAdd, SyncCore } from "../core/index.ts";
import { EmoteNamer, type ServerId } from "../domain/index.ts";
import type { EmoteAddInteraction } from "./emote-add-interaction.ts";
import { FeedbackRouter } from "./feedback-router.ts";
import { Logger, LogLevel } from "./logger.ts";
import type { ServerLock } from "./server-lock.ts";
import type { SlashReply } from "./slash-request.ts";

interface PendingEmoteAdd {
  serverId: ServerId;
  userId: string;
  prepared: PreparedEmoteAdd;
  commandPath: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export class EmoteAddPreviews {
  private static readonly PREVIEW_TTL_MS = 5 * 60_000;
  private readonly pending = new Map<string, PendingEmoteAdd>();

  public constructor(private readonly core: SyncCore, private readonly lock: ServerLock) {}

  public open(serverId: ServerId, userId: string, commandPath: string, preparation: EmoteAddPreparation): SlashReply {
    if ("feedback" in preparation) return FeedbackRouter.format([preparation.feedback]);

    const { emote, previewImage: image } = preparation;
    const preview = { emoteUrl: `https://7tv.app/emotes/${emote.id}`, originalName: emote.name, image };
    if ("importFailure" in preparation) {
      return {
        ...preview,
        importError: "This emote cannot be imported: its converted image exceeds Discord's 256 KB emoji limit.",
      };
    }

    const id = crypto.randomUUID();
    const expiresAt = Date.now() + EmoteAddPreviews.PREVIEW_TTL_MS;
    const timer = setTimeout(() => this.pending.delete(id), EmoteAddPreviews.PREVIEW_TTL_MS);
    timer.unref();
    const { prepared } = preparation;
    this.pending.set(id, { serverId, userId, commandPath, prepared, expiresAt, timer });
    return { ...preview, id, defaultName: prepared.defaultName, slotNotice: preparation.slotNotice };
  }

  public async handleInteraction(request: EmoteAddInteraction): Promise<void> {
    if (!request.isAdministrator) return request.reply("Only members with the Administrator permission can add emotes.");
    const { previewId } = request;
    const pending = this.pending.get(previewId);
    if (!pending || pending.expiresAt <= Date.now() || pending.serverId !== request.serverId || pending.userId !== request.userId) {
      return request.reply("This emote preview is no longer active. Run `/emote add` again or repeat `/search` to start over.");
    }

    const { action } = request;
    if (action.kind === "name") return request.showNameForm(pending.prepared.emote.name);
    if (action.kind === "submit" && !EmoteNamer.isValid(action.name)) {
      return request.reply("Use 2–32 characters: only letters (A–Z), numbers, and underscores. Click **Choose name** on the preview to try again.");
    }

    // Claim synchronously before deferring or waiting for the Server lock, so a button and a form cannot both confirm.
    this.pending.delete(previewId);
    clearTimeout(pending.timer);
    if (action.kind === "cancel") return request.reply("Cancelled. No emote was added.");

    const name = action.kind === "submit" ? action.name : undefined;
    await request.defer();
    let reply: string;
    try {
      const { feedback } = await this.lock.run(pending.serverId, () =>
        this.core.addEmote(pending.serverId, pending.prepared, name),
      );
      reply = FeedbackRouter.format(feedback.map((message) => {
        const nextStep = message.reason === "emote-name-taken" ? "and choose another name."
          : message.reason === "emote-name-changed" ? "to review the name."
          : message.reason === "emote-promotion-unavailable" ? "to start over." : null;
        return nextStep ? { ...message, text: `${message.text} Run \`/${pending.commandPath}\` again ${nextStep}` } : message;
      }));
    } catch {
      Logger.write(LogLevel.error, `/${pending.commandPath} confirmation failed in ${pending.serverId}.`);
      reply = `Something went wrong. Run \`/${pending.commandPath}\` again to retry.`;
    }
    await request.reply(reply);
  }
}
