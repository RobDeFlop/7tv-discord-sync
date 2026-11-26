import { AddEmoteCommand, type PreparedEmoteAdd } from "../../core/index.ts";
import { EmoteNamer, type ServerId } from "../../domain/index.ts";
import type { EmoteAddInteraction } from "../emote-add-interaction.ts";
import { FeedbackRouter } from "../feedback-router.ts";
import { SlashCommand, type SlashOption } from "../slash-command.ts";
import type { SlashReply, SlashRequest } from "../slash-request.ts";

interface PendingEmoteAdd {
  serverId: ServerId;
  userId: string;
  prepared: PreparedEmoteAdd;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

/** /emote add <link> */
export class EmoteAddSlashCommand extends SlashCommand {
  private static readonly PREVIEW_TTL_MS = 5 * 60_000;

  public readonly path = "emote add";
  public readonly description = "Preview a 7TV emote before adding it to this Server";
  public override readonly options: ReadonlyArray<SlashOption> = [
    { name: "link", description: "7TV emote link", type: "string", required: true },
  ];

  protected override readonly needsLock = false;
  private readonly pending = new Map<string, PendingEmoteAdd>();

  protected async run(serverId: ServerId, request: SlashRequest): Promise<SlashReply> {
    const prepared = await this.core.prepareEmoteAdd(serverId, this.requiredString(request, "link"));
    if ("feedback" in prepared) return FeedbackRouter.format([prepared.feedback]);

    const id = crypto.randomUUID();
    const expiresAt = Date.now() + EmoteAddSlashCommand.PREVIEW_TTL_MS;
    const timer = setTimeout(() => this.pending.delete(id), EmoteAddSlashCommand.PREVIEW_TTL_MS);
    timer.unref();
    this.pending.set(id, { serverId, userId: request.userId, prepared, expiresAt, timer });
    return {
      id,
      originalName: prepared.emote.name,
      defaultName: prepared.defaultName,
      image: { animated: prepared.image.animated, bytes: new Uint8Array(prepared.image.bytes) },
    };
  }

  public async handleInteraction(request: EmoteAddInteraction): Promise<void> {
    if (!request.isAdministrator) return request.reply("Only members with the Administrator permission can add emotes.");
    const { previewId } = request;
    const pending = this.pending.get(previewId);
    if (!pending || pending.expiresAt <= Date.now() || pending.serverId !== request.serverId || pending.userId !== request.userId) {
      return request.reply("This emote preview is no longer active. Run `/emote add` again to start over.");
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
      reply = await this.lock.run(pending.serverId, () => this.apply(pending.serverId, new AddEmoteCommand(pending.prepared, name)));
    } catch (error) {
      console.error(`/emote add confirmation failed in ${pending.serverId}:`, error);
      reply = "Something went wrong. Run `/emote add` again to retry.";
    }
    await request.reply(reply);
  }
}
