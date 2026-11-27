import { Application } from "./bot/application.ts";
import { Config, MissingConfigError } from "./config.ts";
import { Logger, LogLevel } from "./logger.ts";

let operation = "read_config";
try {
  const config = Config.fromEnv();
  operation = "start_application";
  await new Application(config).start();
} catch (error) {
  const configFields = error instanceof MissingConfigError ? ` missing=${error.variables.join(",")}` : "";
  Logger.write(LogLevel.error, `startup_failed operation=${operation} ${Logger.failure(error)}${configFields}`);
  process.exit(1);
}
