import { DiscordJsAdapter } from "../adapters/discord/discordjs.ts";
import { SevenTvAdapter } from "../adapters/seventv/index.ts";
import { PostgresStore } from "../adapters/store/postgres-store.ts";
import type { Config } from "../config.ts";
import { SyncCore } from "../core/index.ts";
import { ImagePipeline } from "../image/pipeline.ts";
import { DiscordBot } from "./discordjs-bot.ts";
import { FeedbackRouter } from "./feedback-router.ts";
import { GatewayEvents } from "./gateway-events.ts";
import { ServerLock } from "./server-lock.ts";
import { SlashCommandRegistry } from "./slash-command-registry.ts";

/** Wires the production adapters from the config into the sync core and the bot surface. */
export class Application {
  private readonly store: PostgresStore;
  private readonly bot: DiscordBot;

  public constructor(private readonly config: Config) {
    const client = DiscordJsAdapter.createClient();
    const lock = new ServerLock();
    this.store = new PostgresStore(config.databaseUrl);
    const sevenTv = new SevenTvAdapter(new ImagePipeline());
    const core = new SyncCore(sevenTv, new DiscordJsAdapter(client), this.store);
    const feedback = new FeedbackRouter(this.store, DiscordBot.logChannel(client));
    const events = new GatewayEvents(core, this.store, feedback, lock, DiscordBot.servers(client));
    events.listenToSevenTv(sevenTv);
    this.bot = new DiscordBot(client, events, new SlashCommandRegistry(core, lock));
  }

  public async start(): Promise<void> {
    await this.store.migrate();
    await this.bot.start(this.config.discordToken);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void this.stop());
  }

  public async stop(): Promise<void> {
    await this.bot.stop();
    await this.store.close();
    process.exit(0);
  }
}
