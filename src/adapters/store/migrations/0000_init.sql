CREATE TABLE "servers" (
	"server_id" text PRIMARY KEY NOT NULL,
	"linked_user_id" text,
	"log_channel_id" text,
	"trending" jsonb NOT NULL,
	"managed_emotes" jsonb NOT NULL,
	"reserved_slots" jsonb NOT NULL,
	"requested_emotes" jsonb NOT NULL,
	"problems" jsonb NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
