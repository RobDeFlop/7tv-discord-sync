import type { SyncReport } from "../sync-report.ts";
import type { SyncedServer } from "../synced-server.ts";
import { Command } from "./command.ts";

/** Unlink the 7TV user, either deleting the Source Set's emotes or keeping them as Reserved Slots. */
export class UnlinkSourceSetCommand extends Command {
  public constructor(private readonly keepAsReserved: boolean) {
    super();
  }

  public override async execute(synced: SyncedServer, report: SyncReport): Promise<void> {
    const { state } = synced;
    if (!state.linkedUserId) {
      report.say("error", "No 7TV user is linked to this Server.");
      return;
    }

    const sourced = state.managedOfTier("source");
    for (const managed of sourced) {
      if (this.keepAsReserved) report.change({ type: "reserved", name: synced.emojiOf(managed).name });
      else await synced.removeManaged(managed, report, "unlinked");
    }
    state.unlinkSource(this.keepAsReserved);
    report.say(
      "info",
      this.keepAsReserved
        ? `Unlinked. ${sourced.length} emotes were kept as Reserved Slots.`
        : `Unlinked. ${sourced.length} emotes were deleted.`,
    );
  }
}
