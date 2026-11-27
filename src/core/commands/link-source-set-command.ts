import type { SevenTvUser } from "../../domain/index.ts";
import type { SyncedServer } from "../synced-server.ts";
import type { SyncReport } from "../sync-report.ts";
import { Command } from "./command.ts";

/** Link a 7TV user; their active set becomes the Source Set. */
export class LinkSourceSetCommand extends Command {
  public override readonly requestsSync = true;

  public constructor(private readonly user: SevenTvUser) {
    super();
  }

  public override async execute(synced: SyncedServer, report: SyncReport): Promise<void> {
    synced.state.linkUser(this.user.id);
    report.say("info", `Linked ${this.user.username}.`);
  }
}
