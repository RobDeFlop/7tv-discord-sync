import type { Problem, ProblemKind, ServerState, SevenTvEmote } from "../domain/index.ts";
import type { SyncReport } from "./sync-report.ts";

type FailureReason = "too-large" | "unavailable";

/** An emote whose image could not be turned into a Discord emoji. */
export class ImageFailure {
  private static readonly DETAILS: Record<FailureReason, { kind: ProblemKind; text: (name: string) => string }> = {
    "too-large": {
      kind: "too-large",
      text: (name) => `${name} is still over 256 KB after conversion and was skipped.`,
    },
    unavailable: {
      kind: "skipped",
      text: (name) => `${name} could not be downloaded from 7TV.`,
    },
  };

  public constructor(
    private readonly emote: SevenTvEmote,
    private readonly reason: FailureReason,
  ) {}

  public static confirmKnown(state: ServerState, sevenTvEmoteId: string): boolean {
    let known = false;
    for (const { kind } of Object.values(ImageFailure.DETAILS)) {
      const match = { kind, sevenTvEmoteId };
      if (!state.hasProblem(match)) continue;
      state.confirmProblem(match);
      known = true;
    }
    return known;
  }

  public get text(): string {
    return ImageFailure.DETAILS[this.reason].text(this.emote.name);
  }

  public toProblem(): Problem {
    return { kind: ImageFailure.DETAILS[this.reason].kind, message: this.text, sevenTvEmoteId: this.emote.id };
  }

  /** Record the problem and, the first time it is seen, tell the admin. */
  public recordOnce(state: ServerState, report: SyncReport): void {
    const problem = this.toProblem();
    const known = state.hasProblem({ kind: problem.kind, sevenTvEmoteId: this.emote.id });
    state.recordProblem(problem);
    if (!known) report.say("warning", this.text);
  }
}
