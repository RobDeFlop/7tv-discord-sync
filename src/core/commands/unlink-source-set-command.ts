import type { ServerId, SyncResult } from "../../domain/index.ts";
import { SyncReport } from "../sync-report.ts";
import type { SyncContext } from "../sync-context.ts";
import { Command } from "./command.ts";

/** Unlink the 7TV user, either deleting the Source Set's emotes or keeping them as Reserved Slots. */
export class UnlinkSourceSetCommand extends Command {
  public constructor(private readonly keepAsReserved: boolean) {
    super();
  }

  public async execute(server: ServerId, context: SyncContext): Promise<SyncResult> {
    const synced = await context.load(server);
    const { state } = synced;
    if (!state.linkedUserId) return SyncReport.single("error", "No 7TV user is linked to this Server.");

    const report = new SyncReport();
    const sourced = state.managedOfTier("source");
    try {
      for (const managed of sourced) {
        const emoji = synced.emojiOf(managed);
        if (this.keepAsReserved) {
          report.change({ type: "reserved", name: emoji.name });
        } else {
          await synced.deleteEmoji(emoji);
          report.change({ type: "deleted", name: emoji.name, reason: "unlinked" });
        }
      }
      state.unlinkSource(this.keepAsReserved);
    } finally {
      await context.store.save(server, state);
    }
    report.say(
      "info",
      this.keepAsReserved
        ? `Unlinked. ${sourced.length} emotes were kept as Reserved Slots.`
        : `Unlinked. ${sourced.length} emotes were deleted.`,
    );
    return report.toResult();
  }
}
