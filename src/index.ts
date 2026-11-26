import { Application } from "./bot/application.ts";
import { Config } from "./config.ts";

await new Application(Config.fromEnv()).start();
