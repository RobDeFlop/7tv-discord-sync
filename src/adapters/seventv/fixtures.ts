/** Trimmed real-shape 7TV v3 responses, used as fixtures (no live network in tests). */
export class SevenTvFixtures {
  public static readonly EMOTE_ID = "01F6MQ33FG000FFJ97ZB8MWV52";
  public static readonly STATIC_ID = "01EZPHR5N8000C438200A44F1Z";
  public static readonly USER_ID = "01F6ME22ER0000WDA7ERT8XZRP";
  public static readonly SET_ID = "01F6ME22ER0000WDA7ERT8XZAA";

  private static file(name: string, h: number, size: number, format: string, frames = 1) {
    return { name, width: h, height: h, frame_count: frames, size, format };
  }

  public static readonly animatedEmote = {
    id: SevenTvFixtures.EMOTE_ID,
    name: "catJAM",
    animated: true,
    lifecycle: 3,
    host: {
      url: `//cdn.7tv.app/emote/${SevenTvFixtures.EMOTE_ID}`,
      files: [
        SevenTvFixtures.file("1x.webp", 32, 94822, "WEBP", 158),
        SevenTvFixtures.file("2x.webp", 64, 199384, "WEBP", 158),
        SevenTvFixtures.file("4x.webp", 128, 346368, "WEBP", 158),
        SevenTvFixtures.file("2x.avif", 64, 97322, "AVIF", 158),
        SevenTvFixtures.file("1x.gif", 32, 108015, "GIF", 158),
        SevenTvFixtures.file("2x.gif", 64, 341720, "GIF", 158),
        SevenTvFixtures.file("4x.gif", 128, 1050253, "GIF", 158),
      ],
    },
  };

  public static readonly staticEmote = {
    id: SevenTvFixtures.STATIC_ID,
    name: "Okayge",
    animated: false,
    lifecycle: 3,
    host: {
      url: `//cdn.7tv.app/emote/${SevenTvFixtures.STATIC_ID}`,
      files: [
        SevenTvFixtures.file("1x.webp", 32, 1000, "WEBP"),
        SevenTvFixtures.file("2x.webp", 64, 2000, "WEBP"),
        SevenTvFixtures.file("4x.webp", 128, 4000, "WEBP"),
        SevenTvFixtures.file("1x.png", 32, 1500, "PNG"),
        SevenTvFixtures.file("4x.png", 128, 5000, "PNG"),
        SevenTvFixtures.file("2x.avif", 64, 900, "AVIF"),
      ],
    },
  };

  public static readonly emoteSet = {
    id: SevenTvFixtures.SET_ID,
    name: "Main",
    emotes: [
      // alias differs from the emote's original name: mirror the alias
      { id: SevenTvFixtures.EMOTE_ID, name: "jam", flags: 0, data: SevenTvFixtures.animatedEmote },
      { id: SevenTvFixtures.STATIC_ID, name: "Okayge", flags: 0, data: SevenTvFixtures.staticEmote },
      // no data: cannot be mirrored, skipped
      { id: "01AAAAAAAAAAAAAAAAAAAAAAAA", name: "ghost", flags: 0 },
    ],
  };

  public static readonly user = {
    id: SevenTvFixtures.USER_ID,
    username: "pascii_",
    display_name: "pascii_",
    emote_sets: [{ id: SevenTvFixtures.SET_ID, name: "Main" }],
    connections: [
      { id: "1", platform: "YOUTUBE", emote_set_id: "01YOUTUBESETAAAAAAAAAAAAAA" },
      { id: "433962696", platform: "TWITCH", emote_set_id: SevenTvFixtures.SET_ID },
    ],
  };

  public static readonly userWithoutSet = {
    id: SevenTvFixtures.USER_ID,
    username: "noset",
    connections: [{ id: "2", platform: "TWITCH", emote_set_id: null }],
  };

  public static readonly trendingResponse = {
    data: { emotes: { count: 2, items: [SevenTvFixtures.animatedEmote, SevenTvFixtures.staticEmote] } },
  };
}
