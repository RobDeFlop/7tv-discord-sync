import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
  type ButtonInteraction,
  type Interaction,
  type InteractionReplyOptions,
  type ModalSubmitInteraction,
} from "discord.js";
import type { ServerId } from "../domain/index.ts";
import { EmoteAddInteraction, type EmoteAddAction, type EmoteAddPreview } from "./emote-add-interaction.ts";

export class DiscordJsEmoteAddInteraction extends EmoteAddInteraction {
  private static readonly PREFIX = "emote-add";
  private static readonly NAME_INPUT = "name";

  private constructor(
    private readonly interaction: ButtonInteraction | ModalSubmitInteraction,
    public readonly previewId: string,
    public readonly action: EmoteAddAction,
  ) {
    super();
  }

  public static from(interaction: Interaction): DiscordJsEmoteAddInteraction | null {
    const button = interaction.isButton();
    if (!button && !interaction.isModalSubmit()) return null;
    const [prefix, id, kind] = interaction.customId.split(":");
    if (prefix !== DiscordJsEmoteAddInteraction.PREFIX || !id) return null;
    if (button && (kind === "add" || kind === "name" || kind === "cancel")) {
      return new DiscordJsEmoteAddInteraction(interaction, id, { kind });
    }
    if (!button && kind === "submit") {
      const name = interaction.fields.getTextInputValue(DiscordJsEmoteAddInteraction.NAME_INPUT);
      return new DiscordJsEmoteAddInteraction(interaction, id, { kind, name });
    }
    return null;
  }

  public static previewReply(preview: EmoteAddPreview): Pick<InteractionReplyOptions, "embeds" | "files" | "components"> {
    const filename = preview.image.animated ? "preview.gif" : "preview.png";
    const embed = new EmbedBuilder()
      .setTitle("7TV emote preview")
      .setImage(`attachment://${filename}`)
      .addFields({ name: "Original 7TV name", value: escapeMarkdown(preview.originalName) });
    const reply = { embeds: [embed], files: [{ attachment: Buffer.from(preview.image.bytes), name: filename }] };
    if (preview.importError !== undefined) {
      embed.setDescription(preview.importError);
      return reply;
    }
    if (preview.defaultName !== preview.originalName) {
      embed.addFields({ name: "Add as", value: escapeMarkdown(preview.defaultName) });
    }
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(this.customId(preview.id, "add")).setLabel("Add").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(this.customId(preview.id, "name")).setLabel("Choose name").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(this.customId(preview.id, "cancel")).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    );
    return { ...reply, components: [buttons] };
  }

  public get serverId(): ServerId | null {
    return this.interaction.guildId;
  }

  public get userId(): string {
    return this.interaction.user.id;
  }

  public get isAdministrator(): boolean {
    return this.interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
  }

  public async showNameForm(originalName: string): Promise<void> {
    if (!this.interaction.isButton()) throw new Error("A naming form must be opened from a button.");
    const name = new TextInputBuilder()
      .setCustomId(DiscordJsEmoteAddInteraction.NAME_INPUT)
      .setStyle(TextInputStyle.Short)
      .setValue(originalName)
      .setRequired(true);
    const modal = new ModalBuilder()
      .setCustomId(DiscordJsEmoteAddInteraction.customId(this.previewId, "submit"))
      .setTitle("Choose an emote name")
      .addLabelComponents(new LabelBuilder().setLabel("Emote name").setTextInputComponent(name));
    await this.interaction.showModal(modal);
  }

  public async defer(): Promise<void> {
    await this.interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  public async reply(content: string): Promise<void> {
    if (this.interaction.deferred) await this.interaction.editReply({ content });
    else await this.interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }

  private static customId(id: string, kind: EmoteAddAction["kind"]): string {
    return `${this.PREFIX}:${id}:${kind}`;
  }
}
