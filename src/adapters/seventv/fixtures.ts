// Trimmed real-shape 7TV v3 responses, used as fixtures (no live network in tests).

export const EMOTE_ID = "01F6MQ33FG000FFJ97ZB8MWV52";
export const STATIC_ID = "01EZPHR5N8000C438200A44F1Z";
export const USER_ID = "01F6ME22ER0000WDA7ERT8XZRP";
export const SET_ID = "01F6ME22ER0000WDA7ERT8XZAA";

const file = (name: string, h: number, size: number, format: string, frames = 1) => ({
  name,
  width: h,
  height: h,
  frame_count: frames,
  size,
  format,
});

export const animatedEmote = {
  id: EMOTE_ID,
  name: "catJAM",
  animated: true,
  lifecycle: 3,
  host: {
    url: `//cdn.7tv.app/emote/${EMOTE_ID}`,
    files: [
      file("1x.webp", 32, 94822, "WEBP", 158),
      file("2x.webp", 64, 199384, "WEBP", 158),
      file("4x.webp", 128, 346368, "WEBP", 158),
      file("2x.avif", 64, 97322, "AVIF", 158),
      file("1x.gif", 32, 108015, "GIF", 158),
      file("2x.gif", 64, 341720, "GIF", 158),
      file("4x.gif", 128, 1050253, "GIF", 158),
    ],
  },
};

export const staticEmote = {
  id: STATIC_ID,
  name: "Okayge",
  animated: false,
  lifecycle: 3,
  host: {
    url: `//cdn.7tv.app/emote/${STATIC_ID}`,
    files: [
      file("1x.webp", 32, 1000, "WEBP"),
      file("2x.webp", 64, 2000, "WEBP"),
      file("4x.webp", 128, 4000, "WEBP"),
      file("1x.png", 32, 1500, "PNG"),
      file("4x.png", 128, 5000, "PNG"),
      file("2x.avif", 64, 900, "AVIF"),
    ],
  },
};

export const emoteSet = {
  id: SET_ID,
  name: "Main",
  emotes: [
    // alias differs from the emote's original name: mirror the alias
    { id: EMOTE_ID, name: "jam", flags: 0, data: animatedEmote },
    { id: STATIC_ID, name: "Okayge", flags: 0, data: staticEmote },
    // no data: cannot be mirrored, skipped
    { id: "01AAAAAAAAAAAAAAAAAAAAAAAA", name: "ghost", flags: 0 },
  ],
};

export const user = {
  id: USER_ID,
  username: "pascii_",
  display_name: "pascii_",
  emote_sets: [{ id: SET_ID, name: "Main" }],
  connections: [
    { id: "1", platform: "YOUTUBE", emote_set_id: "01YOUTUBESETAAAAAAAAAAAAAA" },
    { id: "433962696", platform: "TWITCH", emote_set_id: SET_ID },
  ],
};

export const userWithoutSet = {
  id: USER_ID,
  username: "noset",
  connections: [{ id: "2", platform: "TWITCH", emote_set_id: null }],
};

export const trendingResponse = {
  data: { emotes: { count: 2, items: [animatedEmote, staticEmote] } },
};
