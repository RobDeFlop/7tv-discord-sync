import { Application } from "./bot/application.ts";
import { logger } from "./bot/logger.ts";
import { Config } from "./config.ts";

const config = Config.fromEnv();
try {
  await new Application(config).start();
} catch (error) {
  logger.error("Bot startup failed. Check the database connection and Discord token:", error);
  process.exit(1);
}
