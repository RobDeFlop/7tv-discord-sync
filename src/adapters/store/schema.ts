import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type {
  ManagedEmote,
  Problem,
  RequestedEmote,
  ReservedSlot,
  TrendingSettings,
} from "../../domain/index.ts";

/**
 * One row per Server; everything is scoped by `server_id`, so deleting the row
 * deletes all of the Server's data. Lists are jsonb and any ServerState field the
 * schema does not know yet lands in `extra`, so extending ServerState needs no migration.
 */
export const servers = pgTable("servers", {
  serverId: text("server_id").primaryKey(),
  linkedUserId: text("linked_user_id"),
  logChannelId: text("log_channel_id"),
  trending: jsonb("trending").$type<TrendingSettings>().notNull(),
  managedEmotes: jsonb("managed_emotes").$type<ManagedEmote[]>().notNull(),
  reservedSlots: jsonb("reserved_slots").$type<ReservedSlot[]>().notNull(),
  requestedEmotes: jsonb("requested_emotes").$type<RequestedEmote[]>().notNull(),
  problems: jsonb("problems").$type<Problem[]>().notNull(),
  extra: jsonb("extra").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
