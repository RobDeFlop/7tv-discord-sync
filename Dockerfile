FROM oven/bun:1.4.3
WORKDIR /app

COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --production --frozen-lockfile
COPY src ./src

COPY install/ /install/
ARG BOT_VERSION=0.0.0-dev
RUN sed -i "s/^BOT_VERSION=.*/BOT_VERSION=${BOT_VERSION}/" /install/.example.env
LABEL org.opencontainers.image.description="Discord bot that mirrors a 7TV emote set into a Discord server's emojis. To install ${BOT_VERSION} with Docker Compose (Linux/AMD64), run this in an empty directory: cid=\$(docker create ghcr.io/robdeflop/7tv-discord-sync:${BOT_VERSION}) && docker cp \"\$cid:/install/.\" . && docker rm \"\$cid\" -- then follow the copied README.md to use bundled or external PostgreSQL. No login or clone needed."

USER bun
CMD ["bun", "run", "src/index.ts"]
