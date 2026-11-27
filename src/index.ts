import { Application } from "./bot/application.ts";
import { Config } from "./config.ts";
import { Logger, LogLevel } from "./logger.ts";

let operation = "read_config";
try {
  const config = Config.fromEnv();
  operation = "start_application";
  await new Application(config).start();
} catch (error) {
  Logger.write(LogLevel.error, `startup_failed operation=${operation} ${Logger.failure(error)}`);
  process.exit(1);
}
