import type { APIEmbed } from "discord.js";
import type { EmojiImage, ServerId } from "../domain/index.ts";

export type EmoteAddPreview = {
  emoteUrl: string;
  originalName: string;
  image: EmojiImage;
} & (
  | { id: string; defaultName: string; slotNotice?: string; importError?: never }
  | { importError: string; id?: never; defaultName?: never }
);

export type EmoteAddAction = { kind: "add" | "name" | "cancel" } | { kind: "submit"; name: string };

/** One follow-up action on a private /emote add preview. */
export abstract class EmoteAddInteraction {
  public abstract get previewId(): string;
  public abstract get serverId(): ServerId | null;
  public abstract get userId(): string;
  public abstract get isAdministrator(): boolean;
  public abstract get action(): EmoteAddAction;
  public abstract showNameForm(originalName: string): Promise<void>;
  public abstract defer(): Promise<void>;
  public abstract reply(embed: APIEmbed): Promise<void>;
}
