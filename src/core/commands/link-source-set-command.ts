import type { ServerId, SevenTvUser, SyncResult } from "../../domain/index.ts";
import type { SyncContext } from "../sync-context.ts";
import { Command } from "./command.ts";

/** Link a 7TV user; their active set becomes the Source Set. */
export class LinkSourceSetCommand extends Command {
  public constructor(private readonly link: string | SevenTvUser) {
    super();
  }

  public async execute(server: ServerId, context: SyncContext): Promise<SyncResult> {
    const user = typeof this.link === "string" ? await context.sevenTv.resolveUserLink(this.link) : this.link;
    const state = await context.store.load(server);
    state.linkUser(user.id);
    await context.store.save(server, state);
    const result = await context.reconciler.reconcile(server);
    return {
      changes: result.changes,
      feedback: [{ level: "info", text: `Linked ${user.username}.` }, ...result.feedback],
    };
  }
}
