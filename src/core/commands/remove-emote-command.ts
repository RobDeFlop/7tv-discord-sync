import type { ServerId, SyncResult } from "../../domain/index.ts";
import { SyncReport } from "../sync-report.ts";
import type { SyncContext } from "../sync-context.ts";
import { Command } from "./command.ts";

/** Remove a Managed Emote by its Discord name. */
export class RemoveEmoteCommand extends Command {
  public constructor(private readonly name: string) {
    super();
  }

  public async execute(server: ServerId, context: SyncContext): Promise<SyncResult> {
    const synced = await context.load(server);
    const { state } = synced;
    const emoji = synced.findEmojiByName(this.name);
    if (!emoji) return SyncReport.single("error", `No emoji named ${this.name} on this Server.`);
    const managed = state.findManagedByEmoji(emoji.id);
    if (!managed) {
      return SyncReport.single("error", `${this.name} was not created by this bot, so it cannot be removed here.`);
    }
    await synced.deleteEmoji(emoji);
    state.removeManagedEmote(managed);
    if (managed.tier === "requested") state.removeRequestedEmote(managed.sevenTvEmoteId);
    await context.store.save(server, state);
    return {
      changes: [{ type: "deleted", name: this.name, reason: "removed" }],
      feedback: [{ level: "info", text: `Removed ${this.name}.` }],
    };
  }
}
