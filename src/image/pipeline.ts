import sharp, { type Metadata } from "sharp";
import type { ImageResult } from "../ports/index.ts";

export const DISCORD_EMOJI_MAX_BYTES = 256 * 1024;

export interface PrepareOptions {
  /** Defaults to Discord's 256 KB emoji limit. Output must be strictly smaller. */
  maxBytes?: number;
}

const SIZES = [128, 96, 64, 48, 32];
const COLOURS = [256, 128, 64, 32];

/**
 * Convert a downloaded 7TV image (AVIF, WebP, GIF, PNG, animated or not) to
 * what Discord accepts: PNG for static, GIF for animated, under the size limit.
 * Never returns an oversized file.
 */
export async function prepareEmojiImage(
  input: Uint8Array,
  options: PrepareOptions = {},
): Promise<ImageResult> {
  const maxBytes = options.maxBytes ?? DISCORD_EMOJI_MAX_BYTES;
  try {
    const meta = await sharp(input, { animated: true }).metadata();
    const animated = (meta.pages ?? 1) > 1;
    const bytes = animated
      ? await shrinkAnimated(input, meta, maxBytes)
      : await shrinkStatic(input, maxBytes);
    if (!bytes) return { ok: false, reason: "too-large" };
    return { ok: true, image: { bytes, animated } };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

async function shrinkStatic(input: Uint8Array, maxBytes: number): Promise<Uint8Array | null> {
  const meta = await sharp(input).metadata();
  const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
  const sizes = [longest, ...SIZES.filter((s) => s < longest)];
  for (const size of sizes) {
    for (const colours of [undefined, ...COLOURS.slice(1)]) {
      const out = await sharp(input)
        .resize(size, size, { fit: "inside", withoutEnlargement: true })
        .png(colours ? { palette: true, colours } : { compressionLevel: 9 })
        .toBuffer();
      if (out.length < maxBytes) return out;
    }
  }
  return null;
}

async function shrinkAnimated(
  input: Uint8Array,
  meta: Metadata,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const pages = meta.pages ?? 1;
  const longest = Math.max(meta.width ?? 0, meta.pageHeight ?? meta.height ?? 0);
  const start = Math.min(longest, 128);
  const sizes = [start, ...SIZES.filter((s) => s < start)];
  const delays = meta.delay ?? [];
  for (const size of sizes) {
    for (const keepEvery of [1, 2, 3, 4]) {
      for (const colours of COLOURS) {
        const out = await encodeGif(input, size, keepEvery, colours, pages, delays);
        if (out && out.length < maxBytes) return out;
      }
    }
  }
  return null;
}

async function encodeGif(
  input: Uint8Array,
  size: number,
  keepEvery: number,
  colours: number,
  pages: number,
  delays: number[],
): Promise<Buffer | null> {
  const kept: number[] = [];
  for (let i = 0; i < pages; i += keepEvery) kept.push(i);
  if (kept.length < 2) return null;
  const newDelays = kept.map((from, k) => {
    const to = k + 1 < kept.length ? kept[k + 1]! : pages;
    let sum = 0;
    for (let i = from; i < to; i++) sum += delays[i] ?? 100;
    return sum;
  });
  const frames = await Promise.all(
    kept.map((page) =>
      sharp(input, { page })
        .resize(size, size, { fit: "inside", withoutEnlargement: true })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true }),
    ),
  );
  const { width, height } = frames[0]!.info;
  const raw = Buffer.concat(frames.map((f) => f.data));
  return sharp(raw, {
    raw: { width, height: height * frames.length, channels: 4, pageHeight: height },
  })
    .gif({ colours, loop: 0, delay: newDelays, effort: 3 })
    .toBuffer();
}
