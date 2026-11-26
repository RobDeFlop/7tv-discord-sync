import { expect, mock, test } from "bun:test";
import {
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
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
  private readonly permissionsFor = mock(() => new PermissionsBitField());
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

  public async run(commandName: string): Promise<InteractionEditReplyOptions> {
    const interaction = {
      commandName,
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
  const missing = await fixture.run("status");
  expect(missing.content).toContain("Warning: I am missing Embed Links in <#chan-1>.");
  expect(missing.content).toContain("Grant me Embed Links in that channel to restore sync feedback.");
  fixture.expectChannelLookup("chan-1");
  fixture.expectEffectivePermissionChecks(1);
  fixture.expectNoPublicPost();

  fixture.grantChannelEmbedLinksOnly();
  const restored = await fixture.run("status");
  expect(restored.content).toContain("Log channel: <#chan-1>");
  expect(restored.content).not.toContain("Embed Links");
  fixture.expectEffectivePermissionChecks(2);
  fixture.expectNoPublicPost();

  await fixture.syncAndWait();
  fixture.expectPublicPost({
    embeds: [{ title: "Sync results", description: "Sync complete: 0 emoji changes." }],
    allowedMentions: { parse: [] },
  });
});

test("a log channel permission read failure does not break /status or claim Embed Links is missing", async () => {
  const fixture = new LogChannelStatusFixture();
  await fixture.seed("chan-1");
  fixture.failChannelLookupOnce();
  const status = await fixture.run("status");
  fixture.expectChannelLookup("chan-1");
  expect(status.content).toContain("Log channel: <#chan-1>");
  expect(status.content).toContain("Write queue: idle");
  expect(status.content).not.toContain("missing Embed Links");
  fixture.expectNoPublicPost();
});

test("with no log channel, /status and /sync neither look up a channel nor post publicly", async () => {
  const fixture = new LogChannelStatusFixture();
  await fixture.seed(null);
  expect((await fixture.run("status")).content).toContain("Log channel: not set");
  await fixture.syncAndWait();
  fixture.expectNoChannelLookup();
  fixture.expectNoPublicPost();
});
