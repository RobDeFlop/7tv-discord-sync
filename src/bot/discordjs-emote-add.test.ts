import { expect, mock, test } from "bun:test";
import {
  ActionRowBuilder,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  type ChatInputCommandInteraction,
  type Interaction,
  type InteractionEditReplyOptions,
} from "discord.js";
import { DiscordJsSlashRequest } from "./discordjs-bot.ts";
import { DiscordJsEmoteAddInteraction } from "./discordjs-emote-add.ts";

const preview = {
  id: "preview-id",
  originalName: "Pog Champ",
  defaultName: "Pog_Champ",
  image: { animated: true, bytes: new Uint8Array([1, 2, 3]) },
};

test("the deferred private slash reply renders the image, names, and confirmation buttons", async () => {
  const interaction = {
    deferred: false,
    deferReply: mock(async (options: { flags: MessageFlags }) => { interaction.deferred = true; }),
    editReply: mock(async (options: InteractionEditReplyOptions) => {}),
  };
  const request = new DiscordJsSlashRequest(interaction as unknown as ChatInputCommandInteraction);
  await request.defer();
  await request.reply(preview);
  expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  const [reply] = interaction.editReply.mock.calls[0]!;
  expect(reply.files).toEqual([{ name: "preview.gif", attachment: Buffer.from(preview.image.bytes) }]);
  const embed = reply.embeds?.[0];
  if (!(embed instanceof EmbedBuilder)) throw new Error("Expected an emote preview embed");
  expect(embed.toJSON()).toMatchObject({ image: { url: "attachment://preview.gif" }, fields: [
    { name: "Original 7TV name", value: "Pog Champ" },
    { name: "Add as", value: "Pog\\_Champ" },
  ] });
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
    originalName: preview.originalName,
    image: { ...preview.image, animated: false },
    importError,
  });
  expect(reply.files).toEqual([{ name: "preview.png", attachment: Buffer.from(preview.image.bytes) }]);
  expect(reply.components).toBeUndefined();
  const embed = reply.embeds?.[0];
  if (!(embed instanceof EmbedBuilder)) throw new Error("Expected an emote preview embed");
  expect(embed.toJSON()).toMatchObject({
    description: importError,
    image: { url: "attachment://preview.png" },
    fields: [{ name: "Original 7TV name", value: preview.originalName }],
  });
});

test("the Choose name button opens a prefilled modal, and its submission routes to the same preview", async () => {
  const row = DiscordJsEmoteAddInteraction.previewReply(preview).components?.[0];
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
  const reply = mock(async (options: { content: string; flags: MessageFlags }) => {});
  const submission = DiscordJsEmoteAddInteraction.from({
    customId: form.custom_id,
    isButton: () => false,
    isModalSubmit: () => true,
    fields: { getTextInputValue },
    reply,
  } as unknown as Interaction);
  expect(getTextInputValue).toHaveBeenCalledWith(label.component.custom_id);
  expect(submission?.previewId).toBe(preview.id);
  expect(submission?.action).toEqual({ kind: "submit", name: "poggers" });
  await submission?.reply("This emote preview is no longer active.");
  expect(reply).toHaveBeenCalledWith({ content: "This emote preview is no longer active.", flags: MessageFlags.Ephemeral });
});
