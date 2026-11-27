import { expect, mock, test } from "bun:test";
import {
  ActionRowBuilder,
  ComponentType,
  PermissionsBitField,
  PermissionFlagsBits,
  MessageFlags,
  ModalBuilder,
  type ChatInputCommandInteraction,
  type Interaction,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
} from "discord.js";
import { DiscordJsSlashRequest } from "./discordjs-bot.ts";
import { DiscordJsEmoteAddInteraction } from "./discordjs-emote-add.ts";

const preview = {
  id: "preview-id",
  emoteUrl: "https://7tv.app/emotes/e1",
  originalName: "Pog Champ",
  defaultName: "Pog_Champ",
  image: { animated: true, bytes: new Uint8Array([1, 2, 3]) },
};

test.each([true, false])("private preview preserves the names, link and confirmation buttons (Embed Links: %s)", async (hasEmbedLinks) => {
  const interaction = {
    appPermissions: new PermissionsBitField(hasEmbedLinks ? PermissionFlagsBits.EmbedLinks : 0n),
    deferred: false,
    deferReply: mock(async (options: { flags: MessageFlags }) => { interaction.deferred = true; }),
    editReply: mock(async (options: InteractionEditReplyOptions) => {}),
  };
  const request = new DiscordJsSlashRequest(interaction as unknown as ChatInputCommandInteraction);
  await request.defer();
  const slotNotice = "Adding this emote could remove a lower-precedence Managed Emote.";
  await request.reply({ ...preview, slotNotice });
  expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  const [reply] = interaction.editReply.mock.calls[0]!;
  if (hasEmbedLinks) {
    expect(reply.files).toEqual([{ name: "preview.gif", attachment: Buffer.from(preview.image.bytes) }]);
    expect(reply.embeds?.[0]).toMatchObject({
      title: "➕ Confirm emote add", url: preview.emoteUrl, description: slotNotice, image: { url: "attachment://preview.gif" },
      fields: [
        { name: "Original 7TV name", value: "Pog Champ" },
        { name: "Add as", value: "Pog\\_Champ" },
        { name: "7TV emote", value: `[Open on 7TV](${preview.emoteUrl})` },
      ],
    });
  } else {
    expect(reply.embeds).toBeUndefined();
    expect(reply.files).toBeUndefined();
    expect(reply.content).toStartWith(`**➕ Confirm emote add**\n\n${preview.emoteUrl}\n\n${slotNotice}`);
    expect(reply.content).toContain("**Original 7TV name**\nPog Champ");
    expect(reply.content).toContain("**Add as**\nPog\\_Champ");
    expect(reply.content).toContain(preview.emoteUrl);
  }
  const row = reply.components?.[0];
  if (!(row instanceof ActionRowBuilder)) throw new Error("Expected emote preview buttons");
  const buttons = row.toJSON().components;
  expect(buttons).toMatchObject([{ label: "Add" }, { label: "Choose name" }, { label: "Cancel" }]);
  expect(buttons.map((button) => DiscordJsEmoteAddInteraction.from({
    customId: "custom_id" in button ? button.custom_id : undefined,
    isButton: () => true,
  } as unknown as Interaction)?.action.kind)).toEqual(["add", "name", "cancel"]);
});

test("an oversized preview renders its image and explanation without confirmation controls", () => {
  const importError = "This emote cannot be imported.";
  const reply = DiscordJsEmoteAddInteraction.previewReply({
    emoteUrl: preview.emoteUrl,
    originalName: preview.originalName,
    image: { ...preview.image, animated: false },
    importError,
  }, true);
  expect(reply.files).toEqual([{ name: "preview.png", attachment: Buffer.from(preview.image.bytes) }]);
  expect(reply.components).toBeUndefined();
  const embed = reply.embeds?.[0];
  expect(embed).toMatchObject({
    description: importError,
    image: { url: "attachment://preview.png" },
    title: "❌ Cannot import this emote",
    fields: [{ name: "Original 7TV name", value: preview.originalName }, { name: "7TV emote", value: `[Open on 7TV](${preview.emoteUrl})` }],
  });
});

test("the Choose name button opens a prefilled modal, and its submission routes to the same preview", async () => {
  const row = DiscordJsEmoteAddInteraction.previewReply(preview, true).components?.[0];
  if (!(row instanceof ActionRowBuilder)) throw new Error("Expected emote preview buttons");
  const button = row.toJSON().components[1]!;
  const showModal = mock(async (modal: ModalBuilder) => {});
  const chooseName = DiscordJsEmoteAddInteraction.from({
    customId: "custom_id" in button ? button.custom_id : undefined,
    isButton: () => true,
    showModal,
  } as unknown as Interaction);
  await chooseName?.showNameForm(preview.originalName);
  const [modal] = showModal.mock.calls[0]!;
  const form = modal.toJSON();
  const label = form.components[0];
  if (label?.type !== ComponentType.Label || label.component.type !== ComponentType.TextInput) {
    throw new Error("Expected the emote name input");
  }
  expect(label.component.value).toBe(preview.originalName);

  const getTextInputValue = mock((id: string) => "poggers");
  const reply = mock(async (options: InteractionReplyOptions) => {});
  const submission = DiscordJsEmoteAddInteraction.from({
    customId: form.custom_id,
    appPermissions: new PermissionsBitField(PermissionFlagsBits.EmbedLinks),
    isButton: () => false,
    isModalSubmit: () => true,
    fields: { getTextInputValue },
    reply,
  } as unknown as Interaction);
  expect(getTextInputValue).toHaveBeenCalledWith(label.component.custom_id);
  expect(submission?.previewId).toBe(preview.id);
  expect(submission?.action).toEqual({ kind: "submit", name: "poggers" });
  const expired = { title: "❌ Couldn't complete that", description: "This emote preview is no longer active." };
  await submission?.reply(expired);
  expect(reply).toHaveBeenCalledWith({ embeds: [expired], flags: MessageFlags.Ephemeral });
});
