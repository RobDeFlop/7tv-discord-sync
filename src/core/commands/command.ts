import type { ServerId, SyncResult } from "../../domain/index.ts";
import type { SyncContext } from "../sync-context.ts";

/** An admin command. Each subclass knows how to carry itself out. */
export abstract class Command {
  /** May throw a DomainError; the sync core turns it into feedback. */
  public abstract execute(server: ServerId, context: SyncContext): Promise<SyncResult>;
}
