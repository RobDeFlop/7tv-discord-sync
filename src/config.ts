/** The single place configuration is read from the environment. */
export class Config {
  private static readonly REQUIRED = ["DISCORD_TOKEN", "DATABASE_URL"] as const;

  private constructor(
    public readonly discordToken: string,
    public readonly databaseUrl: string,
  ) {}

  public static fromEnv(env: Record<string, string | undefined> = process.env): Config {
    const missing = Config.REQUIRED.filter((k) => !env[k]);
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
    }
    return new Config(env.DISCORD_TOKEN!, env.DATABASE_URL!);
  }
}
