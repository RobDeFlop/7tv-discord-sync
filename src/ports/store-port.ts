import type { ServerId, ServerState } from "../domain/index.ts";

export abstract class StorePort {
  /** Returns an empty state for an unknown Server. */
  public abstract load(server: ServerId): Promise<ServerState>;
  public abstract save(server: ServerId, state: ServerState): Promise<void>;
  /** For catch-up and the scheduler: every Server with stored state. */
  public abstract listServers(): Promise<ServerId[]>;
  public abstract remove(server: ServerId): Promise<void>;
}
