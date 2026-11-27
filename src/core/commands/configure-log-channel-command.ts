import type { SyncedServer } from "../synced-server.ts";
import type { SyncReport } from "../sync-report.ts";
import { Command } from "./command.ts";

/** Choose the channel automatic-sync feedback goes to. */
export class ConfigureLogChannelCommand extends Command {
  public constructor(private readonly logChannelId: string) {
    super();
  }

  public override async execute(synced: SyncedServer, report: SyncReport): Promise<void> {
    synced.state.setLogChannel(this.logChannelId);
    report.say("info", "Log channel updated.");
  }
}
