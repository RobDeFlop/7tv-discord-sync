import { describe, expect, test } from "bun:test";
import { SevenTvFixtures } from "./fixtures.ts";
import { SevenTvMapper, type ApiEmote } from "./mapping.ts";

describe("SevenTvMapper.sourceUrl", () => {
  test("never picks AVIF for an animated emote, even when it is the smallest", () => {
    const url = SevenTvMapper.sourceUrl(SevenTvFixtures.animatedEmote as ApiEmote);
    expect(url).not.toContain(".avif");
    expect(url).toMatch(/\.(webp|gif)$/);
  });

  test("an animated emote with only AVIF has no usable source", () => {
    const emote = {
      ...SevenTvFixtures.animatedEmote,
      host: { ...SevenTvFixtures.animatedEmote.host, files: SevenTvFixtures.animatedEmote.host.files.filter((f) => f.format === "AVIF") },
    };
    expect(SevenTvMapper.sourceUrl(emote as ApiEmote)).toBeNull();
  });
});
