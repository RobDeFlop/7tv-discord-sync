import { Application } from "./bot/application.ts";
import { Logger, LogLevel } from "./bot/logger.ts";
import { Config } from "./config.ts";

const config = Config.fromEnv();
try {
  await new Application(config).start();
} catch {
  Logger.write(LogLevel.error, "Bot startup failed. Check the database connection and Discord token.");
  process.exit(1);
}
