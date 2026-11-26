import type { ServerId, SyncResult } from "../../domain/index.ts";
import { SyncReport } from "../sync-report.ts";
import type { SyncContext } from "../sync-context.ts";
import { Command } from "./command.ts";

/** Choose the channel automatic-sync feedback goes to. */
export class ConfigureLogChannelCommand extends Command {
  public constructor(private readonly logChannelId: string) {
    super();
  }

  public async execute(server: ServerId, context: SyncContext): Promise<SyncResult> {
    const state = await context.store.load(server);
    state.setLogChannel(this.logChannelId);
    await context.store.save(server, state);
    return SyncReport.single("info", "Log channel updated.");
  }
}
