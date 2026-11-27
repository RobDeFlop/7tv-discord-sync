import { Application } from "./bot/application.ts";
import { Logger, logger } from "./bot/logger.ts";
import { Config } from "./config.ts";

const config = Config.fromEnv();
try {
  await new Application(config).start();
} catch (error) {
  logger.error("Bot startup failed. Check the database connection and Discord token:", Logger.diagnostics(error));
  process.exit(1);
}
