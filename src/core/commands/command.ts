import type { SyncedServer } from "../synced-server.ts";
import type { SyncReport } from "../sync-report.ts";

/** An admin command. Each subclass knows how to carry itself out. */
export abstract class Command {
  public readonly requestsSync: boolean = false;

  /** The Server session persists state and translates DomainError into feedback. */
  public abstract execute(synced: SyncedServer, report: SyncReport): Promise<void>;
}
