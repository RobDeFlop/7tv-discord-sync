import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { emptyServerState, type ServerId, type ServerState } from "../../domain/index.ts";
import type { StorePort } from "../../ports/index.ts";
import { servers } from "./schema.ts";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

export interface PostgresStore extends StorePort {
  /** Apply pending drizzle migrations. Call once at startup. */
  migrate(): Promise<void>;
  close(): Promise<void>;
}

const KNOWN = new Set([
  "managedEmotes",
  "reservedSlots",
  "requestedEmotes",
  "linkedUserId",
  "trending",
  "logChannelId",
  "problems",
]);

/** Pass `config.databaseUrl`. */
export function createPostgresStore(databaseUrl: string): PostgresStore {
  const client = postgres(databaseUrl);
  const db = drizzle(client);

  return {
    async migrate() {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    },
    async close() {
      await client.end();
    },
    async load(server: ServerId): Promise<ServerState> {
      const [row] = await db.select().from(servers).where(eq(servers.serverId, server));
      if (!row) return emptyServerState();
      return {
        ...row.extra,
        managedEmotes: row.managedEmotes,
        reservedSlots: row.reservedSlots,
        requestedEmotes: row.requestedEmotes,
        linkedUserId: row.linkedUserId,
        trending: row.trending,
        logChannelId: row.logChannelId,
        problems: row.problems,
      } as ServerState;
    },
    async save(server: ServerId, state: ServerState) {
      const extra = Object.fromEntries(Object.entries(state).filter(([k]) => !KNOWN.has(k)));
      const values = {
        serverId: server,
        linkedUserId: state.linkedUserId,
        logChannelId: state.logChannelId,
        trending: state.trending,
        managedEmotes: state.managedEmotes,
        reservedSlots: state.reservedSlots,
        requestedEmotes: state.requestedEmotes,
        problems: state.problems,
        extra,
        updatedAt: new Date(),
      };
      const { serverId: _id, ...update } = values;
      await db.insert(servers).values(values).onConflictDoUpdate({ target: servers.serverId, set: update });
    },
    async listServers() {
      const rows = await db.select({ id: servers.serverId }).from(servers);
      return rows.map((r) => r.id);
    },
    async remove(server: ServerId) {
      await db.delete(servers).where(eq(servers.serverId, server));
    },
  };
}
