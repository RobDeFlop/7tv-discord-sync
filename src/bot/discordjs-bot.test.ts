import { expect, mock, test } from "bun:test";
import {
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  type APIEmbed,
  type ChatInputCommandInteraction,
  type Client,
  type InteractionEditReplyOptions,
} from "discord.js";
import { SyncCore } from "../core/index.ts";
import { FakeServers } from "../testing/bot-fakes.ts";
import { FakeDiscord, FakeSevenTv, FakeStore } from "../testing/fakes.ts";
import { DiscordBot, DiscordJsSlashRequest } from "./discordjs-bot.ts";
import { FeedbackRouter } from "./feedback-router.ts";
import { GatewayEvents } from "./gateway-events.ts";
import { SlashCommandRegistry } from "./slash-command-registry.ts";

test("DiscordJsSlashRequest sends the queue confirmation as an ephemeral deferred embed", async () => {
  const interaction = {
    appPermissions: new PermissionsBitField(PermissionFlagsBits.EmbedLinks),
    deferred: false,
    deferReply: mock(async () => {}),
    editReply: mock(async () => {}),
    followUp: mock(async () => {}),
  };
  const request = new DiscordJsSlashRequest(interaction as unknown as ChatInputCommandInteraction);
  const embed = { title: "Sync queued" };
  await request.defer();
  interaction.deferred = true;
  await request.reply(embed);
  expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  expect(interaction.editReply).toHaveBeenCalledWith({ embeds: [embed] });
  await request.editOriginal("Sync complete: 1 emoji changes.");
  expect(interaction.editReply).toHaveBeenLastCalledWith({
    content: "Sync complete: 1 emoji changes.", embeds: [], components: [], allowedMentions: { parse: [] },
  });
  expect(interaction.followUp).not.toHaveBeenCalled();
});

test("/search defers privately and renders the matched catalog emote with confirmation controls", async () => {
  const discord = new FakeDiscord();
  discord.addServer("server");
  const sevenTv = new FakeSevenTv();
  sevenTv.addEmote({ id: "e1", name: "Kappa", animated: false });
  const store = new FakeStore();
  const core = new SyncCore(sevenTv, discord, store);
  const log = DiscordBot.logChannel({} as Client);
  const registry = new SlashCommandRegistry(core, new FeedbackRouter(core, log), log);
  const interaction = {
    commandName: "search",
    options: { getSubcommand: () => null, get: () => ({ value: "kappa" }) },
    guildId: "server",
    user: { id: "admin" },
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
    appPermissions: new PermissionsBitField(PermissionFlagsBits.EmbedLinks),
    deferred: false,
    deferReply: mock(async () => { interaction.deferred = true; }),
    editReply: mock(async (_options: InteractionEditReplyOptions) => {}),
  };
  await registry.handle(new DiscordJsSlashRequest(interaction as unknown as ChatInputCommandInteraction));
  expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  const reply = interaction.editReply.mock.calls[0]![0];
  expect(reply.embeds).toMatchObject([{ image: { url: "attachment://preview.png" }, fields: [
    { value: "Kappa" }, { value: "https://7tv.app/emotes/e1" },
  ] }]);
  expect(reply.components).toHaveLength(1);
  expect(discord.emojis("server")).toEqual([]);
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
    const logChannel = DiscordBot.logChannel({ channels: { fetch: this.fetchChannel } } as unknown as Client);
    const feedback = new FeedbackRouter(core, logChannel);
    this.events = new GatewayEvents(core, feedback, new FakeServers());
    this.registry = new SlashCommandRegistry(core, feedback, logChannel);
  }

  public async seed(channelId: string | null): Promise<void> {
    const state = await this.store.load(this.serverId);
    if (channelId !== null) state.setLogChannel(channelId);
    await this.store.save(this.serverId, state);
  }

  public async run(commandName: string, hasEmbedLinks = true): Promise<InteractionEditReplyOptions> {
    const interaction = {
      commandName,
      createdTimestamp: Date.now(),
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
  fixture.expectNoPublicPost();
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
  expect(sync.content).toContain("private reply");
  fixture.expectNoPublicPost();
});
