import type { ManagedTier, ServerId, SyncResult } from "../../domain/index.ts";
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
    const report = new SyncReport();
    report.change({ type: "deleted", name: this.name, reason: "removed" });
    report.say("info", `Removed ${this.name}.`);
    const warning = this.comesBackWarning(managed.tier);
    if (warning) report.say("warning", warning);
    return report.toResult();
  }

  /** Removing a mirrored emote is not remembered, so say when it will return. */
  private comesBackWarning(tier: ManagedTier): string | null {
    if (tier === "source") {
      return `${this.name} is part of the Source Set and will come back on the next sync unless it is removed from the 7TV set.`;
    }
    if (tier === "trending") return "Trending Fill may fill this slot again on the next sync.";
    return null;
  }
}
