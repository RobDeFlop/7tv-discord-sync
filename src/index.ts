import { FailureLog } from "./bot/failure-log.ts";
import { Application } from "./bot/application.ts";
import { Config } from "./config.ts";

const config = Config.fromEnv();
try {
  await new Application(config).start();
} catch (error) {
  new FailureLog(error).write("Bot startup failed. Check the database connection and Discord token:");
  process.exit(1);
}
