import type { ServerId } from "../domain/index.ts";
import type { DiscordPort, SevenTvPort, StorePort } from "../ports/index.ts";
import { Reconciler } from "./reconciler.ts";
import { SlotAllocator } from "./slot-allocator.ts";
import { SyncedServer } from "./synced-server.ts";

/** The collaborators commands and reconcile steps work with. */
export class SyncContext {
  public readonly allocator: SlotAllocator;
  public readonly reconciler: Reconciler;

  public constructor(
    public readonly sevenTv: SevenTvPort,
    public readonly discord: DiscordPort,
    public readonly store: StorePort,
  ) {
    this.allocator = new SlotAllocator();
    this.reconciler = new Reconciler(this);
  }

  /** Load a Server's state and emojis, registering hand-made emojis as Reserved Slots. */
  public async load(server: ServerId): Promise<SyncedServer> {
    const state = await this.store.load(server);
    const emojis = await this.discord.listEmojis(server);
    state.syncOwnership(emojis);
    return new SyncedServer(server, state, emojis, this.discord);
  }
}
