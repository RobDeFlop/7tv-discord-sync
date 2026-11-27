import type { ManagedEmote, SevenTvUserId } from "../../domain/index.ts";
import type { SevenTvPort } from "../../ports/index.ts";
import type { SyncReport } from "../sync-report.ts";
import type { SyncedServer } from "../synced-server.ts";
import { Command } from "./command.ts";

/** Remove a Managed Emote by its Discord name. */
export class RemoveEmoteCommand extends Command {
  public constructor(private readonly name: string, private readonly sevenTv: SevenTvPort) {
    super();
  }

  public override async execute(synced: SyncedServer, report: SyncReport): Promise<void> {
    const { state } = synced;
    const emoji = synced.findEmojiByName(this.name);
    if (!emoji) return report.say("error", `No emoji named ${this.name} on this Server.`);
    const managed = state.findManagedByEmoji(emoji.id);
    if (!managed) return report.say("error", `${this.name} was not created by this bot, so it cannot be removed here.`);
    await synced.removeManaged(managed, report, "removed");
    report.say("info", `Removed ${this.name}.`);
    const warning = await this.comesBackWarning(managed, state.linkedUserId);
    if (warning) report.say("warning", warning);
  }

  /** Removing a mirrored emote is not remembered, so say when it will return. */
  private async comesBackWarning(managed: ManagedEmote, linked: SevenTvUserId | null): Promise<string | null> {
    if (managed.tier === "trending") return "Trending Fill may fill this slot again on the next sync.";
    if (managed.tier === "requested") {
      if (!linked) return null;
      const unknown = "Could not check the Source Set. If this emote is in it, it will come back on the next sync.";
      try {
        const user = await this.sevenTv.getUser(linked);
        if (!user) return unknown;
        if (!user.activeSetId) return null;
        const set = await this.sevenTv.getSet(user.activeSetId);
        if (!set) return unknown;
        if (!set.emotes.some((emote) => emote.id === managed.sevenTvEmoteId)) return null;
      } catch {
        return unknown;
      }
    }
    return `${this.name} is part of the Source Set and will come back on the next sync unless it is removed from the 7TV set.`;
  }
}
