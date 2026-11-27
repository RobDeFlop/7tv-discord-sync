import type { DiscordEmojiId, EmojiImage, SevenTvEmote } from "../../domain/index.ts";

export type PreparedEmoteAdd = PreparedEmoteUpload | PreparedEmotePromotion;

abstract class PreparedEmote {
  private readonly emoteSnapshot: SevenTvEmote;

  protected constructor(emote: SevenTvEmote, public readonly defaultName: string) {
    this.emoteSnapshot = { ...emote };
  }

  public get emote(): SevenTvEmote {
    return { ...this.emoteSnapshot };
  }
}

export class PreparedEmoteUpload extends PreparedEmote {
  private readonly imageSnapshot: EmojiImage;

  public constructor(
    emote: SevenTvEmote,
    defaultName: string,
    image: EmojiImage,
    public readonly approvedDisplacement: DiscordEmojiId | null = null,
    public readonly defaultNameWasSuffixed = false,
  ) {
    super(emote, defaultName);
    this.imageSnapshot = { animated: image.animated, bytes: new Uint8Array(image.bytes) };
  }

  public get uploadImage(): EmojiImage {
    const { animated, bytes } = this.imageSnapshot;
    return { animated, bytes: new Uint8Array(bytes) };
  }
}

export class PreparedEmotePromotion extends PreparedEmote {
  public constructor(emote: SevenTvEmote, defaultName: string, public readonly discordEmojiId: DiscordEmojiId) {
    super(emote, defaultName);
  }
}
