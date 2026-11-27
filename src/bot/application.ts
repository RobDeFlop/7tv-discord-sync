import { DiscordJsAdapter } from "../adapters/discord/discordjs.ts";
import { SevenTvAdapter } from "../adapters/seventv/index.ts";
import { PostgresStore } from "../adapters/store/postgres-store.ts";
import type { Config } from "../config.ts";
import { SyncCore } from "../core/index.ts";
import { ImagePipeline } from "../image/pipeline.ts";
import { DiscordBot } from "./discordjs-bot.ts";
import { FeedbackRouter } from "./feedback-router.ts";
import { GatewayEvents } from "./gateway-events.ts";
import { Logger, LogLevel } from "./logger.ts";
import { SlashCommandRegistry } from "./slash-command-registry.ts";

/** Wires the production adapters from the config into the sync core and the bot surface. */
export class Application {
  private readonly store: PostgresStore;
  private readonly bot: DiscordBot;
  private readonly core: SyncCore;
  private readonly unsubscribe: () => void;

  public constructor(private readonly config: Config) {
    const client = DiscordJsAdapter.createClient();
    this.store = new PostgresStore(config.databaseUrl);
    const sevenTv = new SevenTvAdapter(new ImagePipeline());
    this.core = new SyncCore(sevenTv, new DiscordJsAdapter(client), this.store, (server, operation, error) => {
      Logger.write(LogLevel.error, `sync_failed server=${server} operation=${operation} error_kind=${error instanceof Error ? "Error" : typeof error}`);
    });
    const logChannel = DiscordBot.logChannel(client);
    const feedback = new FeedbackRouter(this.core, logChannel);
    const events = new GatewayEvents(this.core, feedback, DiscordBot.servers(client));
    this.unsubscribe = events.listenToSevenTv(sevenTv);
    this.bot = new DiscordBot(client, events, new SlashCommandRegistry(this.core, feedback, logChannel));
  }

  public async start(): Promise<void> {
    await this.store.migrate();
    await this.bot.start(this.config.discordToken);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void this.stop());
  }

  public async stop(): Promise<void> {
    this.unsubscribe();
    await this.bot.stop();
    await this.core.stop();
    await this.store.close();
    process.exit(0);
  }
}
