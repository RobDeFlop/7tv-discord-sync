FROM oven/bun:1.4.3
WORKDIR /app

COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --production --frozen-lockfile
COPY src ./src

USER bun
CMD ["bun", "run", "src/index.ts"]
