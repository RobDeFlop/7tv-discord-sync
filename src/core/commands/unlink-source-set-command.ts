import type { Change, ServerId, SyncResult } from "../../domain/index.ts";
import { SyncReport } from "../sync-report.ts";
import type { SyncContext } from "../sync-context.ts";
import { Command } from "./command.ts";

/** Unlink the 7TV user, either deleting the Source Set's emotes or keeping them as Reserved Slots. */
export class UnlinkSourceSetCommand extends Command {
  public constructor(private readonly keepEmotes: boolean) {
    super();
  }

  public async execute(server: ServerId, context: SyncContext): Promise<SyncResult> {
    const synced = await context.load(server);
    const { state } = synced;
    if (!state.linkedUserId) return SyncReport.single("error", "No 7TV user is linked to this Server.");

    const changes: Change[] = [];
    const sourced = state.managedOfTier("source");
    for (const managed of sourced) {
      const emoji = synced.emojiOf(managed);
      if (this.keepEmotes) {
        changes.push({ type: "reserved", name: emoji.name });
      } else {
        await synced.deleteEmoji(emoji);
        changes.push({ type: "deleted", name: emoji.name, reason: "unlinked" });
      }
    }
    // Kept emotes simply stop being Managed Emotes; ownership sync makes them Reserved Slots.
    state.releaseManagedOfTier("source");
    state.unlinkUser();
    state.clearPending();
    await context.store.save(server, state);
    const text = this.keepEmotes
      ? `Unlinked. ${sourced.length} emotes were kept as Reserved Slots.`
      : `Unlinked. ${sourced.length} emotes were deleted.`;
    return { changes, feedback: [{ level: "info", text }] };
  }
}
