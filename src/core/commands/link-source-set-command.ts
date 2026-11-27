import type { SevenTvPort } from "../../ports/index.ts";
import type { SyncedServer } from "../synced-server.ts";
import type { SyncReport } from "../sync-report.ts";
import { Command } from "./command.ts";

/** Link a 7TV user; their active set becomes the Source Set. */
export class LinkSourceSetCommand extends Command {
  public override readonly requestsSync = true;

  public constructor(private readonly link: string, private readonly sevenTv: SevenTvPort) {
    super();
  }

  public override async execute(synced: SyncedServer, report: SyncReport): Promise<void> {
    const user = await this.sevenTv.resolveUserLink(this.link);
    synced.state.linkUser(user.id);
    report.say("info", `Linked ${user.username}.`);
  }
}
