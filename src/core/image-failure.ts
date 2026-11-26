import type { Problem, SevenTvEmote } from "../domain/index.ts";

/** An emote whose image could not be turned into a Discord emoji. */
export class ImageFailure {
  public constructor(
    private readonly emote: SevenTvEmote,
    private readonly reason: "too-large" | "unavailable",
  ) {}

  public get text(): string {
    return this.reason === "too-large"
      ? `${this.emote.name} is still over 256 KB after conversion and was skipped.`
      : `${this.emote.name} could not be downloaded from 7TV.`;
  }

  public toProblem(): Problem {
    return {
      kind: this.reason === "too-large" ? "too-large" : "skipped",
      message: this.text,
      sevenTvEmoteId: this.emote.id,
    };
  }
}
