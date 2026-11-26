export interface Config {
  discordToken: string;
  databaseUrl: string;
}

/** The single place configuration is read from the environment. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const required = ["DISCORD_TOKEN", "DATABASE_URL"] as const;
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
  return { discordToken: env.DISCORD_TOKEN!, databaseUrl: env.DATABASE_URL! };
}
