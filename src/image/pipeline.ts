import sharp, { type Metadata } from "sharp";
import { Logger, LogLevel } from "../logger.ts";
import type { ImageResult } from "../ports/index.ts";

export interface PrepareOptions {
  /** Defaults to Discord's 256 KB emoji limit. Output must be strictly smaller. */
  maxBytes?: number;
}

/**
 * Convert a downloaded 7TV image (AVIF, WebP, GIF, PNG, animated or not) to
 * what Discord accepts: PNG for static, GIF for animated, under the size limit.
 * If conversion cannot fit, return a still preview without an upload image.
 */
export class ImagePipeline {
  public static readonly DISCORD_EMOJI_MAX_BYTES = 256 * 1024;

  private static readonly SIZES = [128, 96, 64, 48, 32];
  private static readonly COLOURS = [256, 128, 64, 32];

  private readonly maxBytes: number;

  public constructor(options: PrepareOptions = {}) {
    this.maxBytes = options.maxBytes ?? ImagePipeline.DISCORD_EMOJI_MAX_BYTES;
  }

  /**
   * `declaredAnimated` is 7TV's own flag; the pipeline probes the bytes itself,
   * so it is only a hint for subclasses (tests) that skip probing.
   */
  public async prepare(input: Uint8Array, _declaredAnimated?: boolean): Promise<ImageResult> {
    const maxBytes = this.maxBytes;
    let operation = "probe_image";
    try {
      const meta = await sharp(input, { animated: true }).metadata();
      const animated = (meta.pages ?? 1) > 1;
      operation = animated ? "encode_gif" : "encode_png";
      const bytes = animated
        ? await this.shrinkAnimated(input, meta, maxBytes)
        : await this.shrinkStatic(input, maxBytes);
      if (bytes) return { ok: true, image: { bytes, animated } };

      operation = "encode_preview";
      const preview = await sharp(input, { page: 0 })
        .resize(128, 128, { fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
      return { ok: false, reason: "too-large", previewImage: { bytes: preview, animated: false } };
    } catch (error) {
      Logger.write(LogLevel.warn, `image_prepare_failed operation=${operation} ${Logger.failure(error)}`);
      return { ok: false, reason: "unavailable" };
    }
  }

  private async shrinkStatic(input: Uint8Array, maxBytes: number): Promise<Uint8Array | null> {
    const meta = await sharp(input).metadata();
    const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
    const sizes = [longest, ...ImagePipeline.SIZES.filter((s) => s < longest)];
    for (const size of sizes) {
      for (const colours of [undefined, ...ImagePipeline.COLOURS.slice(1)]) {
        const out = await sharp(input)
          .resize(size, size, { fit: "inside", withoutEnlargement: true })
          .png(colours ? { palette: true, colours } : { compressionLevel: 9 })
          .toBuffer();
        if (out.length < maxBytes) return out;
      }
    }
    return null;
  }

  private async shrinkAnimated(input: Uint8Array, meta: Metadata, maxBytes: number): Promise<Uint8Array | null> {
    const pages = meta.pages ?? 1;
    const longest = Math.max(meta.width ?? 0, meta.pageHeight ?? meta.height ?? 0);
    const start = Math.min(longest, 128);
    const sizes = [start, ...ImagePipeline.SIZES.filter((s) => s < start)];
    const delays = meta.delay ?? [];
    for (const size of sizes) {
      for (const keepEvery of [1, 2, 3, 4]) {
        for (const colours of ImagePipeline.COLOURS) {
          const out = await this.encodeGif(input, size, keepEvery, colours, pages, delays);
          if (out && out.length < maxBytes) return out;
        }
      }
    }
    return null;
  }

  private async encodeGif(
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
      const to = kept[k + 1] ?? pages;
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
    const [first] = frames;
    if (!first) return null;
    const { width, height } = first.info;
    const raw = Buffer.concat(frames.map((f) => f.data));
    return sharp(raw, {
      raw: { width, height: height * frames.length, channels: 4, pageHeight: height },
    })
      .gif({ colours, loop: 0, delay: newDelays, effort: 3 })
      .toBuffer();
  }
}
