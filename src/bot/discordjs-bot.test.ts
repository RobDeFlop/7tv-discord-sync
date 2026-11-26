import { expect, mock, test } from "bun:test";
import {
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
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

async function setupLogChannelStatus(channelId: string | null) {
  const server = "server-1";
  const discord = new FakeDiscord();
  discord.addServer(server);
  const store = new FakeStore();
  const state = await store.load(server);
  if (channelId !== null) state.setLogChannel(channelId);
  await store.save(server, state);
  const core = new SyncCore(new FakeSevenTv(), discord, store);
  const lock = new ServerLock();

  const botMember = { permissions: new PermissionsBitField(PermissionFlagsBits.EmbedLinks) };
  const permissionsFor = mock(() => new PermissionsBitField());
  const send = mock(async () => {});
  const channel = {
    isSendable: () => true,
    isDMBased: () => false,
    guild: { members: { fetchMe: async () => botMember } },
    permissionsFor,
    send,
  };
  const fetch = mock(async () => channel);
  const logChannel = DiscordBot.logChannel({ channels: { fetch } } as unknown as Client);
  const events = new GatewayEvents(core, store, new FeedbackRouter(store, logChannel), lock, new FakeServers());
  const registry = new SlashCommandRegistry(core, lock, events, logChannel);

  const run = async (commandName: string) => {
    const interaction = {
      commandName,
      deferred: false,
      guildId: server,
      memberPermissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
      options: { getSubcommand: () => null },
      deferReply: mock(async () => { interaction.deferred = true; }),
      editReply: mock(async (_options: InteractionEditReplyOptions) => {}),
    };
    await registry.handle(new DiscordJsSlashRequest(interaction as unknown as ChatInputCommandInteraction));
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    return interaction.editReply.mock.calls[0]![0];
  };
  return { botMember, permissionsFor, fetch, send, events, run };
}

test("private /status warns when the log channel denies Embed Links and clears when it grants it", async () => {
  const { botMember, permissionsFor, fetch, send, events, run } = await setupLogChannelStatus("chan-1");
  const missing = await run("status");
  expect(missing.content).toContain("Warning: I am missing Embed Links in <#chan-1>.");
  expect(missing.content).toContain("Grant me Embed Links in that channel to restore sync feedback.");
  expect(fetch).toHaveBeenCalledWith("chan-1");
  expect(permissionsFor).toHaveBeenCalledWith(botMember);
  expect(send).not.toHaveBeenCalled();

  // A channel can grant Embed Links even when the Server-level permissions do not.
  botMember.permissions.remove(PermissionFlagsBits.EmbedLinks);
  permissionsFor.mockReturnValue(new PermissionsBitField(PermissionFlagsBits.EmbedLinks));
  const restored = await run("status");
  expect(restored.content).toContain("Log channel: <#chan-1>");
  expect(restored.content).not.toContain("Embed Links");
  expect(permissionsFor).toHaveBeenCalledTimes(2);
  expect(send).not.toHaveBeenCalled();

  await run("sync");
  await events.idle();
  expect(send).toHaveBeenCalledWith({
    embeds: [{ title: "Sync results", description: "Sync complete: 0 emoji changes." }],
    allowedMentions: { parse: [] },
  });
});

test("a log channel permission read failure does not break /status or claim Embed Links is missing", async () => {
  const { fetch, send, run } = await setupLogChannelStatus("chan-1");
  fetch.mockRejectedValueOnce(new Error("Cannot read channel"));
  const status = await run("status");
  expect(fetch).toHaveBeenCalledWith("chan-1");
  expect(status.content).toContain("Log channel: <#chan-1>");
  expect(status.content).toContain("Write queue: idle");
  expect(status.content).not.toContain("missing Embed Links");
  expect(send).not.toHaveBeenCalled();
});

test("with no log channel, /status and /sync neither look up a channel nor post publicly", async () => {
  const { fetch, send, events, run } = await setupLogChannelStatus(null);
  expect((await run("status")).content).toContain("Log channel: not set");
  await run("sync");
  await events.idle();
  expect(fetch).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
