import {
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import type { ServerId } from "../domain/index.ts";
import { LogChannel } from "./feedback-router.ts";
import { GuildDirectory, type GatewayEvents } from "./gateway-events.ts";
import type { SlashCommandRegistry } from "./slash-command-registry.ts";
import { SlashRequest } from "./slash-request.ts";

/** A slash command interaction behind SlashRequest. Replies are always ephemeral. */
export class DiscordJsSlashRequest extends SlashRequest {
  private static readonly MAX_MESSAGE = 2000;
  private replied = false;

  public constructor(private readonly interaction: ChatInputCommandInteraction) {
    super();
  }

  public get commandPath(): string {
    const sub = this.interaction.options.getSubcommand(false);
    return sub ? `${this.interaction.commandName} ${sub}` : this.interaction.commandName;
  }

  public get serverId(): ServerId | null {
    return this.interaction.guildId;
  }

  public get isAdministrator(): boolean {
    return this.interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
  }

  public string(name: string): string | null {
    const value = this.interaction.options.get(name)?.value;
    return typeof value === "string" ? value : null;
  }

  public boolean(name: string): boolean | null {
    const value = this.interaction.options.get(name)?.value;
    return typeof value === "boolean" ? value : null;
  }

  public async defer(): Promise<void> {
    await this.interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  public async reply(text: string): Promise<void> {
    const content = text.slice(0, DiscordJsSlashRequest.MAX_MESSAGE);
    if (this.interaction.deferred && !this.replied) await this.interaction.editReply({ content });
    else if (this.replied || this.interaction.replied) await this.interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    else await this.interaction.reply({ content, flags: MessageFlags.Ephemeral });
    this.replied = true;
  }
}

class DiscordJsLogChannel extends LogChannel {
  private static readonly MAX_MESSAGE = 2000;

  public constructor(private readonly client: Client) {
    super();
  }

  public async send(channelId: string, text: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error(`Channel ${channelId} cannot be written to`);
    await channel.send({ content: text.slice(0, DiscordJsLogChannel.MAX_MESSAGE), allowedMentions: { parse: [] } });
  }

  public static of(client: Client): LogChannel {
    return new DiscordJsLogChannel(client);
  }
}

class DiscordJsGuilds extends GuildDirectory {
  public constructor(private readonly client: Client) {
    super();
  }

  public guildIds(): ServerId[] {
    return [...this.client.guilds.cache.keys()];
  }
}

/** Connects a discord.js Client to the bot: gateway events and slash commands in, core calls out. */
export class DiscordBot {
  public constructor(
    private readonly client: Client,
    private readonly events: GatewayEvents,
    private readonly registry: SlashCommandRegistry,
  ) {}

  public static logChannel(client: Client): LogChannel {
    return DiscordJsLogChannel.of(client);
  }

  public static guilds(client: Client): GuildDirectory {
    return new DiscordJsGuilds(client);
  }

  /** Log in, register the slash commands, and catch up every Server. */
  public async start(token: string): Promise<void> {
    this.listen();
    await this.client.login(token);
  }

  public async stop(): Promise<void> {
    await this.client.destroy();
  }

  private listen(): void {
    const c = this.client;
    c.once("clientReady", () => void this.onReady());
    c.on("guildCreate", (guild) => void this.events.guildJoined(guild.id));
    c.on("guildDelete", (guild) => void this.events.guildLeft(guild.id));
    c.on("emojiCreate", (emoji) => void this.events.emojiChanged(emoji.guild.id));
    c.on("emojiDelete", (emoji) => void this.events.emojiChanged(emoji.guild.id));
    c.on("emojiUpdate", (_old, emoji) => void this.events.emojiChanged(emoji.guild.id));
    c.on("guildUpdate", (before, after) => {
      if (before.premiumTier !== after.premiumTier) void this.events.boostChanged(after.id);
    });
    c.on("interactionCreate", (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      this.registry.handle(new DiscordJsSlashRequest(interaction)).catch((e) => console.error("Command failed:", e));
    });
  }

  private async onReady(): Promise<void> {
    try {
      await this.client.application?.commands.set(this.registry.definitions() as never);
      await this.events.catchUp();
      console.log(`Ready as ${this.client.user?.tag}, caught up ${this.client.guilds.cache.size} Servers.`);
    } catch (err) {
      console.error("Startup failed:", err);
    }
  }
}
