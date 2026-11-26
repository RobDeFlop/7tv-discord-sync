import type { LinkSourceSetCommand, SyncCore } from "../core/index.ts";
import type { ServerId } from "../domain/index.ts";
import type { GatewayEvents } from "./gateway-events.ts";
import type { ServerLock } from "./server-lock.ts";
import { SlashCommand } from "./slash-command.ts";

/** Accept immediately; the background job, not the interaction, holds the Server lock. */
export abstract class BackgroundSyncCommand extends SlashCommand {
  protected override readonly needsLock = false;

  public constructor(core: SyncCore, lock: ServerLock, private readonly events: GatewayEvents) {
    super(core, lock);
  }

  protected queue(server: ServerId, link?: LinkSourceSetCommand): string {
    this.events.requestSync(server, link);
    return "Sync queued. Check /status for progress or the configured log channel for the result.";
  }
}
