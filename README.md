# 7tv-discord-sync

Keeps a Discord server's emojis in sync with emotes from 7TV (one way, 7TV to Discord). See `GLOSSARY.md` for the vocabulary.

## Setup

You need [Bun](https://bun.sh), a Postgres database and a Discord application with a bot.

1. Create an application at the [Discord developer portal](https://discord.com/developers/applications), add a bot, and copy its token.
2. Invite the bot to your server with the `bot` and `applications.commands` scopes and the **Manage Expressions** permission (needed to add, rename and remove emojis). It also needs to see and post in the log channel you pick. No privileged intents are required.
3. Install and configure:

   ```sh
   bun install
   export DISCORD_TOKEN=...                       # bot token
   export DATABASE_URL=postgres://user:pass@host:5432/dbname
   ```

4. Run it:

   ```sh
   bun run start
   ```

   On startup the bot applies the database migrations, registers its slash commands and reconciles every server it is in.

Other scripts: `bun test`, `bun run typecheck`.

## Commands

All commands are for administrators and answer only to you (ephemeral).

| Command | What it does |
| --- | --- |
| `/emote add <link> [name]` | Add a 7TV emote (a Requested Emote) |
| `/emote remove <name>` | Remove an emoji the bot created |
| `/set link <7tv user link>` | Mirror that user's active emote set (Source Set) |
| `/set unlink <delete\|keep>` | Stop mirroring; delete the emotes or keep them as Reserved Slots |
| `/trending <on\|off> [period]` | Fill free slots with trending emotes (day, week, month, all-time) |
| `/sync` | Reconcile now |
| `/status` | Slot usage, settings, problems and pending Discord writes |
| `/config log-channel <channel>` | Where automatic sync messages are posted |

The bot also syncs on its own: when it joins a server, when emojis change, when the boost level changes, when the linked 7TV set changes, and once for every server at startup. Messages from those syncs go to the log channel if one is set; problems are always shown in `/status`. Leaving a server deletes its stored data.
