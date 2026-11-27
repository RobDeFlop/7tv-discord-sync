# 7tv-discord-sync

A Discord bot that keeps a server's emojis in sync with emotes from [7TV](https://7tv.app). Sync is one-way, from 7TV to Discord. See `GLOSSARY.md` for the vocabulary.

- Mirror a 7TV user's active emote set and follow it when they switch sets.
- Add single 7TV emotes by link.
- Optionally fill leftover slots with trending emotes.
- Emojis you uploaded yourself are never touched.

## Requirements

- [Bun](https://bun.sh) 1.4 or newer
- A Postgres database (local or hosted, e.g. Neon or Supabase)
- A Discord application with a bot

## Setup

### 1. Get the code

```sh
git clone https://github.com/RobDeFlop/7tv-discord-sync.git
cd 7tv-discord-sync
bun install
```

### 2. Create the Discord bot

1. Open the [Discord developer portal](https://discord.com/developers/applications) and click **New Application**.
2. Open the **Bot** tab, click **Reset Token** and copy the token. Keep it secret.
3. No privileged intents are needed. Leave Message Content, Server Members and Presence off.

### 3. Invite the bot to your server

Copy the **Application ID** from **General Information**, put it into this URL and open it:

```
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot+applications.commands&permissions=1073761280
```

This grants **Manage Expressions** (to add, rename and remove emojis), plus **View Channel**, **Send Messages** and **Embed Links** (for the log channel). Make sure the bot has these three channel permissions in the channel you'll use as the log channel.

If the bot is already installed with an older invite, open the configured log channel's **Edit Channel → Permissions** settings and allow **Embed Links** for the bot or its role. Run `/status` to check for a missing **Embed Links** warning.

### 4. Set up a database

Any Postgres database works. Create an empty database, for example `7tv_sync`, and note its connection string. The bot creates its tables itself on startup.

### 5. Configure

Copy the example file and fill in your values:

```sh
cp .example.env .env
```

| Variable | Value |
| --- | --- |
| `DISCORD_TOKEN` | The bot token from step 2 |
| `DATABASE_URL` | Your Postgres connection string, e.g. `postgres://user:password@localhost:5432/7tv_sync` |

Bun loads `.env` automatically. `.env` is gitignored, so your token is never committed.

### 6. Run

```sh
bun run start
```

On startup the bot applies the database migrations, registers its slash commands and syncs every server it is in. Slash commands are registered globally, so the first time they can take a few minutes to show up in Discord.

## Using the bot

All commands are for administrators only, and only you see the replies.

A typical first setup:

1. `/config log-channel #bot-log`: where messages from automatic syncs are posted.
2. `/set link https://7tv.app/users/<id>`: mirror that user's active emote set.
3. `/trending on`: optionally fill the remaining free slots with trending emotes.
4. `/status`: check slot usage and any problems.

### Commands

| Command | What it does |
| --- | --- |
| `/emote add <link>` | Preview a 7TV emote, then add it as a Requested Emote |
| `/emote remove <name>` | Remove an emoji the bot created |
| `/set link <7tv user link>` | Mirror that user's active emote set (Source Set) |
| `/set unlink <delete\|keep>` | Stop mirroring; delete the emotes or keep them as Reserved Slots |
| `/trending <on\|off> [period]` | Fill free slots with trending emotes (day, week, month, all-time; default week) |
| `/sync` | Queue a sync and confirm it privately |
| `/status` | Slot usage, settings, problems and pending Discord writes |
| `/config log-channel <channel>` | Where automatic sync messages are posted |

In the private emote preview, choose **Add** to use the displayed name, **Choose name** to edit the original 7TV name and add on submission, or **Cancel** to leave without adding anything. Names must be 2–32 characters and use only letters (A–Z), numbers, and underscores. The suggested name may already include a numeric suffix. If your custom name is taken, or the displayed name becomes taken before confirmation, the bot rejects it rather than adding a suffix. If the preview expires, run `/emote add` again.

When an oversized image cannot be imported, the private preview explains Discord's 256 KB limit without adding a problem to `/status`.

### How slots are shared

Discord limits static and animated emojis separately (50, 100, 150 or 250 each, depending on boost level). When slots run out, they go in this order:

1. Emojis you uploaded yourself (never changed by the bot)
2. Emotes added with `/emote add`
3. The mirrored 7TV set
4. Trending emotes

An emote higher in the list pushes out one lower in the list. Animated emotes are converted and shrunk to fit Discord's 256 KB limit. During sync, an emote that can't be shrunk enough is skipped and listed in `/status`.

### Automatic syncs

The bot also syncs on its own when it joins a server, when emojis change, when the boost level changes, when the linked 7TV set changes, and once for every server at startup. Feedback from automatic and queued syncs goes to the configured log channel in embeds that separate results, warnings and errors. If there is no log channel or nothing to report, the bot does not post. Recorded problems remain visible in `/status`. Removing the bot from a server deletes that server's stored data; the emojis stay.

## Development

```sh
bun test            # run the tests
bun run typecheck   # type-check
bun run db:generate # regenerate migrations after a schema change (needs DATABASE_URL)
```

Coding standards are in `docs/agents/coding-standards.md`. In conditions, use booleans directly or negate them with `!` rather than comparing them to `true` or `false`. Check for `null` explicitly when it represents a distinct unknown state.
