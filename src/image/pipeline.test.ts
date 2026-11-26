import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { ImagePipeline } from "./pipeline.ts";

const LIMIT = 256 * 1024;

/** Deterministic noise so images do not compress well. */
function noise(length: number): Buffer {
  const buf = Buffer.alloc(length);
  let s = 2463534242;
  for (let i = 0; i < length; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    buf[i] = s & 0xff;
  }
  return buf;
}

async function staticFixture(size: number, format: "webp" | "avif" | "png") {
  return sharp(noise(size * size * 3), { raw: { width: size, height: size, channels: 3 } })
    .toFormat(format, format === "png" ? {} : { quality: 100 })
    .toBuffer();
}

async function animatedFixture(size: number, frames: number) {
  const raw = noise(size * size * 4 * frames);
  return sharp(raw, { raw: { width: size, height: size * frames, channels: 4, pageHeight: size } })
    .webp({ quality: 100, loop: 0, delay: new Array(frames).fill(50) })
    .toBuffer();
}

describe("ImagePipeline", () => {
  test("converts a static WebP to a PNG under the limit", async () => {
    const result = await new ImagePipeline().prepare(await staticFixture(128, "webp"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.animated).toBe(false);
    expect(result.image.bytes.length).toBeLessThan(LIMIT);
    const meta = await sharp(result.image.bytes).metadata();
    expect(meta.format).toBe("png");
  });

  test("converts a static AVIF to PNG", async () => {
    const result = await new ImagePipeline().prepare(await staticFixture(64, "avif"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await sharp(result.image.bytes).metadata()).format).toBe("png");
  });

  test("downscales an oversized static image under the limit", async () => {
    const input = await staticFixture(600, "png");
    expect(input.length).toBeGreaterThan(LIMIT);
    const result = await new ImagePipeline().prepare(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.bytes.length).toBeLessThan(LIMIT);
    const meta = await sharp(result.image.bytes).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBeLessThan(600);
  });

  test("converts an animated WebP to an animated GIF under the limit", async () => {
    const input = await animatedFixture(96, 8);
    const result = await new ImagePipeline().prepare(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.animated).toBe(true);
    expect(result.image.bytes.length).toBeLessThan(LIMIT);
    const meta = await sharp(result.image.bytes, { animated: true }).metadata();
    expect(meta.format).toBe("gif");
    expect(meta.pages).toBeGreaterThan(1);
  });

  test("shrinks a heavy animation by downscaling and dropping frames", async () => {
    const input = await animatedFixture(256, 30);
    const result = await new ImagePipeline().prepare(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.bytes.length).toBeLessThan(LIMIT);
    expect(result.image.animated).toBe(true);
  });

  test("reports too-large when it cannot fit under the limit", async () => {
    const result = await new ImagePipeline({ maxBytes: 100 }).prepare(await staticFixture(200, "png"));
    expect(result).toEqual({ ok: false, reason: "too-large" });
  });

  test("reports unavailable for bytes that are not an image", async () => {
    const result = await new ImagePipeline().prepare(new TextEncoder().encode("not an image"));
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });
});
