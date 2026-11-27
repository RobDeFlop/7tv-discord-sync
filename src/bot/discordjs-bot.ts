import {
  MessageFlags,
  PermissionFlagsBits,
  type APIEmbed,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
} from "discord.js";
import type { ServerId } from "../domain/index.ts";
import { DetailedSlashReply } from "./detailed-slash-reply.ts";
import { DiscordJsEmoteAddInteraction } from "./discordjs-emote-add.ts";
import { LogChannel } from "./feedback-router.ts";
import { ServerDirectory, type GatewayEvents } from "./gateway-events.ts";
import { Logger, LogLevel } from "./logger.ts";
import type { SlashCommandRegistry } from "./slash-command-registry.ts";
import { SlashRequest, type SlashReply } from "./slash-request.ts";

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

  public get createdAt(): number {
    return this.interaction.createdTimestamp;
  }

  public get userId(): string {
    return this.interaction.user.id;
  }

  public stringOption(name: string): string | null {
    const value = this.interaction.options.get(name)?.value;
    return typeof value === "string" ? value : null;
  }

  public booleanOption(name: string): boolean | null {
    const value = this.interaction.options.get(name)?.value;
    return typeof value === "boolean" ? value : null;
  }

  public async defer(): Promise<void> {
    await this.interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  public async reply(reply: SlashReply): Promise<void> {
    const hasEmbedLinks = this.interaction.appPermissions.has(PermissionFlagsBits.EmbedLinks);
    const options = typeof reply === "string"
      ? { content: reply.slice(0, DiscordJsSlashRequest.MAX_MESSAGE) }
      : "originalName" in reply ? DiscordJsEmoteAddInteraction.previewReply(reply, hasEmbedLinks)
      : new DetailedSlashReply(reply).render(hasEmbedLinks);
    if (this.interaction.deferred && !this.replied) await this.interaction.editReply(options);
    else if (this.replied || this.interaction.replied) await this.interaction.followUp({ ...options, flags: MessageFlags.Ephemeral });
    else await this.interaction.reply({ ...options, flags: MessageFlags.Ephemeral });
    this.replied = true;
  }

  public async editOriginal(text: string): Promise<void> {
    await this.interaction.editReply({
      content: text.slice(0, DiscordJsSlashRequest.MAX_MESSAGE).toWellFormed(),
      embeds: [], components: [], allowedMentions: { parse: [] },
    });
  }
}

class DiscordJsLogChannel extends LogChannel {
  public constructor(private readonly client: Client) {
    super();
  }

  public async hasEmbedLinks(channelId: string): Promise<boolean | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isSendable() || channel.isDMBased()) return null;
      const botMember = await channel.guild.members.fetchMe();
      return channel.permissionsFor(botMember)?.has(PermissionFlagsBits.EmbedLinks) ?? null;
    } catch {
      return null;
    }
  }

  public async send(channelId: string, embeds: ReadonlyArray<APIEmbed>): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error(`Channel ${channelId} cannot be written to`);
    await channel.send({ embeds: [...embeds], allowedMentions: { parse: [] } });
  }

  public static of(client: Client): LogChannel {
    return new DiscordJsLogChannel(client);
  }
}

class DiscordJsServers extends ServerDirectory {
  public constructor(private readonly client: Client) {
    super();
  }

  public serverIds(): ServerId[] {
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

  public static servers(client: Client): ServerDirectory {
    return new DiscordJsServers(client);
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
    c.on("guildCreate", (guild) => void this.events.serverJoined(guild.id));
    c.on("guildDelete", (guild) => void this.events.serverLeft(guild.id));
    c.on("emojiCreate", (emoji) => void this.events.emojiChanged(emoji.guild.id));
    c.on("emojiDelete", (emoji) => void this.events.emojiChanged(emoji.guild.id));
    c.on("emojiUpdate", (_old, emoji) => void this.events.emojiChanged(emoji.guild.id));
    c.on("guildUpdate", (before, after) => {
      if (before.premiumTier !== after.premiumTier) void this.events.boostChanged(after.id);
    });
    c.on("interactionCreate", (interaction) => {
      this.onInteraction(interaction).catch(() => Logger.write(LogLevel.error, "Interaction failed."));
    });
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) return this.registry.handle(new DiscordJsSlashRequest(interaction));
    const request = DiscordJsEmoteAddInteraction.from(interaction);
    if (request) await this.registry.handleEmoteAddInteraction(request);
  }

  private async onReady(): Promise<void> {
    try {
      await this.client.application?.commands.set(this.registry.definitions() as never);
      await this.events.catchUp();
      Logger.write(LogLevel.info, `Ready as ${this.client.user?.tag}, caught up ${this.client.guilds.cache.size} Servers.`);
    } catch {
      Logger.write(LogLevel.error, "Startup failed.");
    }
  }
}
