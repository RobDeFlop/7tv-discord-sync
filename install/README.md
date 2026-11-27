# Run 7tv-discord-sync with Docker Compose

Use Docker with Compose on Linux/AMD64 (or Docker Desktop in Linux containers mode). You don't need Bun. Choose **one** database option below; both run a single bot.

## Prepare the bot and its configuration

1. Create an application in the [Discord developer portal](https://discord.com/developers/applications). Under **Bot**, choose **Reset Token** and copy the token. Leave privileged intents off.
2. Copy the **Application ID** from **General Information**. Replace `YOUR_APPLICATION_ID` in the following URL and open it to invite the bot:

   ```text
   https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot+applications.commands&permissions=1073761280
   ```

   The bot needs **Manage Expressions** and, in its log channel, **View Channel**, **Send Messages** and **Embed Links**.
3. In an installation directory you control, create `.env` with owner-only access **before** entering credentials. On Linux/macOS run `if [ -e .env ]; then chmod 600 .env; else install -m 600 .example.env .env; fi`. This preserves an existing configuration. On Windows, use a directory restricted to your account and restrict access to the file before editing. Never share or commit `.env`. Do not share the output of `docker compose config` or `docker inspect`: both can show credentials. Use `docker compose config --quiet` to validate without printing the configuration.
4. Set `DISCORD_TOKEN` in `.env`. When you copy these files from a release image, `BOT_VERSION` is already set to that exact release; leave it unchanged. If using files from the source checkout instead, set `BOT_VERSION` to the desired published version without `v` (for example `1.3.0-beta.1`), never `latest`.

## Option 1: Bundled PostgreSQL (default)

Set `POSTGRES_PASSWORD` in `.env` to a long random password consisting of letters and digits (it is used in a URL). Leave `DATABASE_URL` empty. Then run:

```sh
docker compose up -d
docker compose logs -f bot
```

Compose starts PostgreSQL on its private network, waits for it to be ready, then starts the bot. The bot creates its tables on startup. `docker compose down` stops both services but keeps the database in a named volume. Run `up -d` again from the same directory to reuse it. Do **not** add `-v` to `down` unless you intend to delete the data. Changing `.env` does not reset the password of an initialized database.

## Option 2: Existing PostgreSQL database

Provide a database reachable **from the bot container** and credentials that can create tables and apply migrations. Set `DATABASE_URL` in `.env` to the full connection URL (including any required TLS parameters); `localhost` inside the container is not your database host. Leave `POSTGRES_PASSWORD` empty.

Use the external file **by itself** for every command:

```sh
docker compose -f compose.external.yaml up -d
docker compose -f compose.external.yaml logs -f bot
```

Only the bot starts. To stop it, run `docker compose -f compose.external.yaml down`. Your database is managed separately.

Once the bot is online, run `/status` in Discord to check your server. Global slash commands can take a few minutes to appear the first time.
