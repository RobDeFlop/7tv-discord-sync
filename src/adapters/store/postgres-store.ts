import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { ServerState, type ServerId } from "../../domain/index.ts";
import { StorePort } from "../../ports/index.ts";
import { servers } from "./schema.ts";

/** Stores each Server's ServerState snapshot in one Postgres row. Pass `config.databaseUrl`. */
export class PostgresStore extends StorePort {
  private static readonly MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

  private readonly client: ReturnType<typeof postgres>;
  private readonly db: PostgresJsDatabase;

  public constructor(databaseUrl: string) {
    super();
    this.client = postgres(databaseUrl);
    this.db = drizzle(this.client);
  }

  /** Apply pending drizzle migrations. Call once at startup. */
  public async migrate(): Promise<void> {
    await migrate(this.db, { migrationsFolder: PostgresStore.MIGRATIONS_FOLDER });
  }

  public async close(): Promise<void> {
    await this.client.end();
  }

  public async load(server: ServerId): Promise<ServerState> {
    const [row] = await this.db.select().from(servers).where(eq(servers.serverId, server));
    if (!row) return ServerState.empty();
    return ServerState.fromSnapshot({
      managedEmotes: row.managedEmotes,
      reservedSlots: row.reservedSlots,
      requestedEmotes: row.requestedEmotes,
      linkedUserId: row.linkedUserId,
      trending: row.trending,
      logChannelId: row.logChannelId,
      problems: row.problems,
      extra: row.extra,
    });
  }

  public async save(server: ServerId, state: ServerState): Promise<void> {
    const snapshot = state.toSnapshot();
    const values = {
      linkedUserId: snapshot.linkedUserId,
      logChannelId: snapshot.logChannelId,
      trending: snapshot.trending,
      managedEmotes: snapshot.managedEmotes,
      reservedSlots: snapshot.reservedSlots,
      requestedEmotes: snapshot.requestedEmotes,
      problems: snapshot.problems,
      extra: snapshot.extra ?? {},
      updatedAt: new Date(),
    };
    await this.db
      .insert(servers)
      .values({ serverId: server, ...values })
      .onConflictDoUpdate({ target: servers.serverId, set: values });
  }

  public async listServers(): Promise<ServerId[]> {
    const rows = await this.db.select({ id: servers.serverId }).from(servers);
    return rows.map((r) => r.id);
  }

  public async remove(server: ServerId): Promise<void> {
    await this.db.delete(servers).where(eq(servers.serverId, server));
  }
}
