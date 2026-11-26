import {
  ServerQuotas,
  type Quota,
  type DiscordEmoji,
  type EmojiImage,
  type ServerId,
  type ServerState,
  type SlotOccupant,
} from "../domain/index.ts";
import type { DiscordPort } from "../ports/index.ts";

/**
 * One Server's stored state together with its live Discord emojis, kept
 * consistent while a command or reconcile edits both.
 */
export class SyncedServer {
  private emojis: DiscordEmoji[];
  private quotaLookup: Promise<ServerQuotas> | undefined;

  public constructor(
    public readonly id: ServerId,
    public readonly state: ServerState,
    emojis: ReadonlyArray<DiscordEmoji>,
    private readonly discord: DiscordPort,
  ) {
    this.emojis = [...emojis];
  }

  public findEmojiByName(name: string): DiscordEmoji | undefined {
    return this.emojis.find((e) => e.name === name);
  }

  /**
   * The Discord emoji a slot occupant stands for. Loading drops Managed Emotes
   * whose emoji is gone, so a missing one is a broken invariant, reported as such.
   */
  public emojiOf(occupant: SlotOccupant): DiscordEmoji {
    const emoji = this.emojis.find((e) => e.id === occupant.discordEmojiId);
    if (!emoji) throw new Error(`No Discord emoji ${occupant.discordEmojiId} on server ${this.id}`);
    return emoji;
  }

  /** Slot limits at the Server's boost level, looked up once per load. */
  public quotas(): Promise<ServerQuotas> {
    this.quotaLookup ??= this.discord.getQuotas(this.id);
    return this.quotaLookup;
  }

  public emojiNames(): string[] {
    return this.emojis.map((e) => e.name);
  }

  /** Names of every emoji except the one with `emojiId`. */
  public emojiNamesExcept(emojiId: string): string[] {
    return this.emojis.filter((e) => e.id !== emojiId).map((e) => e.name);
  }

  public emojisIn(quota: Quota): DiscordEmoji[] {
    return this.emojis.filter((e) => ServerQuotas.quotaOf(e.animated) === quota);
  }

  public usedIn(quota: Quota): number {
    return this.emojisIn(quota).length;
  }

  public async createEmoji(name: string, image: EmojiImage): Promise<DiscordEmoji> {
    const created = await this.discord.createEmoji(this.id, { name, image });
    this.emojis = [...this.emojis, created];
    return created;
  }

  public async renameEmoji(emoji: DiscordEmoji, name: string): Promise<void> {
    await this.discord.renameEmoji(this.id, emoji.id, name);
    this.emojis = this.emojis.map((e) => (e.id === emoji.id ? { ...e, name } : e));
  }

  public async deleteEmoji(emoji: DiscordEmoji): Promise<void> {
    await this.discord.deleteEmoji(this.id, emoji.id);
    this.emojis = this.emojis.filter((e) => e.id !== emoji.id);
  }
}
