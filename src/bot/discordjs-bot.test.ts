import { expect, mock, test } from "bun:test";
import {
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  type APIEmbed,
  type ChatInputCommandInteraction,
  type Client,
  type InteractionEditReplyOptions,
  type MessageCreateOptions,
} from "discord.js";
import { SyncCore } from "../core/index.ts";
import { FakeServers } from "../testing/bot-fakes.ts";
import { FakeDiscord, FakeSevenTv, FakeStore } from "../testing/fakes.ts";
import { DiscordBot, DiscordJsSlashRequest } from "./discordjs-bot.ts";
import { FeedbackRouter } from "./feedback-router.ts";
import { GatewayEvents } from "./gateway-events.ts";
import { ServerLock } from "./server-lock.ts";
import { SlashCommandRegistry } from "./slash-command-registry.ts";

test("DiscordJsSlashRequest sends the queue confirmation as an ephemeral deferred embed", async () => {
  const interaction = {
    appPermissions: new PermissionsBitField(PermissionFlagsBits.EmbedLinks),
    deferred: false,
    deferReply: mock(async () => {}),
    editReply: mock(async () => {}),
  };
  const request = new DiscordJsSlashRequest(interaction as unknown as ChatInputCommandInteraction);
  const embed = { title: "Sync queued" };
  await request.defer();
  interaction.deferred = true;
  await request.reply(embed);
  expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  expect(interaction.editReply).toHaveBeenCalledWith({ embeds: [embed] });
});

test("DiscordBot sends log embeds to the configured channel without mentions", async () => {
  const send = mock(async () => {});
  const channel = { isSendable: () => true, send };
  const fetch = mock(async () => channel);
  const log = DiscordBot.logChannel({ channels: { fetch } } as unknown as Client);
  const embeds = [{ title: "Sync warnings", description: "@everyone" }];
  await log.send("chan-1", embeds);
  expect(fetch).toHaveBeenCalledWith("chan-1");
  expect(send).toHaveBeenCalledWith({ embeds, allowedMentions: { parse: [] } });
});

class LogChannelStatusFixture {
  private readonly serverId = "server-1";
  private readonly store = new FakeStore();
  private readonly botMember = { permissions: new PermissionsBitField(PermissionFlagsBits.EmbedLinks) };
  private readonly permissionsFor = mock((): PermissionsBitField | null => new PermissionsBitField());
  private readonly send = mock(async () => {});
  private readonly fetchChannel = mock(async () => ({
    isSendable: () => true,
    isDMBased: () => false,
    guild: { members: { fetchMe: async () => this.botMember } },
    permissionsFor: this.permissionsFor,
    send: this.send,
  }));
  private readonly events: GatewayEvents;
  private readonly registry: SlashCommandRegistry;

  public constructor() {
    const discord = new FakeDiscord();
    discord.addServer(this.serverId);
    const core = new SyncCore(new FakeSevenTv(), discord, this.store);
    const lock = new ServerLock();
    const logChannel = DiscordBot.logChannel({ channels: { fetch: this.fetchChannel } } as unknown as Client);
    this.events = new GatewayEvents(core, this.store, new FeedbackRouter(this.store, logChannel), lock, new FakeServers());
    this.registry = new SlashCommandRegistry(core, lock, this.events, logChannel);
  }

  public async seed(channelId: string | null): Promise<void> {
    const state = await this.store.load(this.serverId);
    if (channelId !== null) state.setLogChannel(channelId);
    await this.store.save(this.serverId, state);
  }

  public async run(commandName: string, hasEmbedLinks = true): Promise<InteractionEditReplyOptions> {
    const interaction = {
      commandName,
      appPermissions: new PermissionsBitField(hasEmbedLinks ? PermissionFlagsBits.EmbedLinks : 0n),
      deferred: false,
      guildId: this.serverId,
      memberPermissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
      options: { getSubcommand: () => null },
      deferReply: mock(async () => { interaction.deferred = true; }),
      editReply: mock(async (_options: InteractionEditReplyOptions) => {}),
    };
    await this.registry.handle(new DiscordJsSlashRequest(interaction as unknown as ChatInputCommandInteraction));
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    return interaction.editReply.mock.calls[0]![0];
  }

  public async status(): Promise<APIEmbed> {
    const reply = await this.run("status");
    expect(reply.content).toBeUndefined();
    expect(reply.embeds).toHaveLength(1);
    const embed = reply.embeds![0]!;
    return "toJSON" in embed ? embed.toJSON() : embed;
  }

  public async syncAndWait(): Promise<void> {
    await this.run("sync");
    await this.events.idle();
  }

  public grantChannelEmbedLinksOnly(): void {
    this.botMember.permissions.remove(PermissionFlagsBits.EmbedLinks);
    this.permissionsFor.mockReturnValue(new PermissionsBitField(PermissionFlagsBits.EmbedLinks));
  }

  public failChannelLookupOnce(): void {
    this.fetchChannel.mockRejectedValueOnce(new Error("Cannot read channel"));
  }

  public makeChannelPermissionsUnavailableOnce(): void {
    this.permissionsFor.mockReturnValueOnce(null);
  }

  public expectChannelLookup(channelId: string): void {
    expect(this.fetchChannel).toHaveBeenCalledWith(channelId);
  }

  public expectNoChannelLookup(): void {
    expect(this.fetchChannel).not.toHaveBeenCalled();
  }

  public expectEffectivePermissionChecks(count: number): void {
    expect(this.permissionsFor).toHaveBeenCalledTimes(count);
    expect(this.permissionsFor).toHaveBeenLastCalledWith(this.botMember);
  }

  public expectPublicPost(options: MessageCreateOptions): void {
    expect(this.send).toHaveBeenCalledWith(options);
  }

  public expectNoPublicPost(): void {
    expect(this.send).not.toHaveBeenCalled();
  }
}

test("private /status warns when the log channel denies Embed Links and clears when it grants it", async () => {
  const fixture = new LogChannelStatusFixture();
  await fixture.seed("chan-1");
  const missing = await fixture.status();
  expect(missing.title).toBe("Action needed");
  expect(missing.description).toContain("Missing **Embed Links** in <#chan-1>.");
  expect(missing.description).toContain("Grant it to the bot in that channel to restore sync feedback.");
  fixture.expectChannelLookup("chan-1");
  fixture.expectEffectivePermissionChecks(1);
  fixture.expectNoPublicPost();

  fixture.grantChannelEmbedLinksOnly();
  const restored = await fixture.status();
  expect(restored.title).toBe("No action needed");
  expect(restored.description).toBeUndefined();
  expect(restored.fields?.find((field) => field.name === "Settings")?.value).toContain("Log channel: <#chan-1>");
  fixture.expectEffectivePermissionChecks(2);
  fixture.expectNoPublicPost();

  await fixture.syncAndWait();
  fixture.expectPublicPost({
    embeds: [{ title: "Sync results", description: "Sync complete: 0 emoji changes." }],
    allowedMentions: { parse: [] },
  });
});

test.each(["a failed log channel lookup", "unavailable channel permissions"] as const)(
  "%s does not break /status or cause an Embed Links warning",
  async (scenario) => {
    const fixture = new LogChannelStatusFixture();
    await fixture.seed("chan-1");
    if (scenario === "a failed log channel lookup") fixture.failChannelLookupOnce();
    else fixture.makeChannelPermissionsUnavailableOnce();

    const status = await fixture.status();
    fixture.expectChannelLookup("chan-1");
    expect(status.title).toBe("No action needed");
    expect(status.description).toBeUndefined();
    expect(status.fields?.find((field) => field.name === "Settings")?.value).toContain("Log channel: <#chan-1>");
    expect(status.fields).toContainEqual({ name: "Write queue", value: "Idle" });
    fixture.expectNoPublicPost();
  },
);

test("with no log channel, /status and /sync neither look up a channel nor post publicly", async () => {
  const fixture = new LogChannelStatusFixture();
  await fixture.seed(null);
  const status = await fixture.status();
  expect(status.title).toBe("No action needed");
  expect(status.description).toBeUndefined();
  expect(status.fields?.find((field) => field.name === "Settings")?.value).toContain("Log channel: Not set");
  await fixture.syncAndWait();
  fixture.expectNoChannelLookup();
  fixture.expectNoPublicPost();
});

test("without Embed Links in the invoking channel, status and queued sync details remain private text", async () => {
  const fixture = new LogChannelStatusFixture();
  await fixture.seed(null);
  const status = await fixture.run("status", false);
  expect(status.embeds).toBeUndefined();
  expect(status.content).toStartWith("No action needed");
  for (const detail of ["Static Slots", "Animated Slots", "Settings", "Log channel: Not set", "Write queue", "Idle"]) {
    expect(status.content).toContain(detail);
  }
  const sync = await fixture.run("sync", false);
  expect(sync.embeds).toBeUndefined();
  expect(sync.content).toStartWith("Sync queued");
  expect(sync.content).toContain("Check `/status`");
  fixture.expectNoPublicPost();
});
