import type { ServerState, SevenTvEmoteId } from "../domain/index.ts";

/** An emoji that got a suffixed name because the wanted one was already taken. */
export class NameCollision {
  private constructor(
    private readonly sevenTvEmoteId: SevenTvEmoteId,
    public readonly text: string,
  ) {}

  public static onAdd(wanted: string, actual: string, sevenTvEmoteId: SevenTvEmoteId): NameCollision {
    return new NameCollision(sevenTvEmoteId, `The name ${wanted} was taken, so the emote was added as ${actual}.`);
  }

  public static onRename(wanted: string, actual: string, sevenTvEmoteId: SevenTvEmoteId): NameCollision {
    return new NameCollision(sevenTvEmoteId, `The name ${wanted} was taken, so the emote was renamed to ${actual}.`);
  }

  /** Record it as a problem. Returns false when the same problem was already recorded. */
  public record(state: ServerState): boolean {
    const known = state.hasProblem({ kind: "renamed-with-suffix", sevenTvEmoteId: this.sevenTvEmoteId, message: this.text });
    state.recordProblem({ kind: "renamed-with-suffix", message: this.text, sevenTvEmoteId: this.sevenTvEmoteId });
    return !known;
  }
}
