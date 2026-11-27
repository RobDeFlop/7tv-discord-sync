/** The single place configuration is read from the environment. */
export class Config {
  private static readonly REQUIRED = ["DISCORD_TOKEN", "DATABASE_URL"] as const;

  private constructor(
    public readonly discordToken: string,
    public readonly databaseUrl: string,
  ) {}

  public static fromEnv(env: Record<string, string | undefined> = process.env): Config {
    const { DISCORD_TOKEN, DATABASE_URL } = env;
    if (!DISCORD_TOKEN || !DATABASE_URL) {
      const missing = Config.REQUIRED.filter((key) => !env[key]);
      throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
    }
    return new Config(DISCORD_TOKEN, DATABASE_URL);
  }
}
