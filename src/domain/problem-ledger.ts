import type { ManagedEmote } from "./slot-occupant.ts";
import type { Problem, SevenTvEmoteId } from "./types.ts";

/** Observations from one Server operation, backed by the previous snapshot's problems. */
export class ProblemLedger {
  private entries: Problem[];
  private readonly observed = new Set<Problem>();
  private readonly sourcePending = new Map<SevenTvEmoteId, Problem>();

  public constructor(previous: readonly Problem[]) {
    this.entries = previous.map((problem) => ({ ...problem }));
  }

  public snapshot(): Problem[] {
    return this.entries.map((problem) => ({ ...problem }));
  }

  /** Record what was seen, returning true only when it warrants new feedback. */
  public observe(problem: Problem): boolean {
    const existing = this.entries.find((entry) => ProblemLedger.sameSubject(entry, problem));
    if (existing?.message === problem.message) {
      this.observed.add(existing);
    } else {
      const entry = { ...problem };
      this.entries = this.entries.filter((item) => !ProblemLedger.sameSubject(item, problem));
      if (existing) this.observed.delete(existing);
      this.entries.push(entry);
      this.observed.add(entry);
    }
    return existing === undefined || (problem.kind === "renamed-with-suffix" && existing.message !== problem.message);
  }

  /** Stage a Source Set observation so an interrupted review does not consume its first warning. */
  public observeSourcePending(emoteId: SevenTvEmoteId, message: string): boolean {
    const problem: Problem = { kind: "pending", sevenTvEmoteId: emoteId, message };
    const fresh = !this.sourcePending.has(emoteId) && !this.entries.some((entry) => ProblemLedger.sameSubject(entry, problem));
    this.sourcePending.set(emoteId, problem);
    return fresh;
  }

  /** Trending Fill does not redownload an image still listed with a known failure. */
  public observeKnownImageFailure(emoteId: SevenTvEmoteId): boolean {
    const known = this.entries.filter((entry) => entry.sevenTvEmoteId === emoteId && ProblemLedger.isImageFailure(entry));
    for (const entry of known) this.observed.add(entry);
    return known.length > 0;
  }

  /** A successful placement supersedes stale failures and pending entries for that emote. */
  public placed(emoteId: SevenTvEmoteId): void {
    this.sourcePending.delete(emoteId);
    this.forget((entry) => entry.sevenTvEmoteId === emoteId && entry.kind !== "renamed-with-suffix");
  }

  /** A successful rename without a suffix supersedes any previous collision notice. */
  public renamedWithoutSuffix(emoteId: SevenTvEmoteId): void {
    this.forget((entry) => entry.sevenTvEmoteId === emoteId && entry.kind === "renamed-with-suffix");
  }

  /** Only the Source Set can declare its pending review complete; interrupted scans keep old entries. */
  public closeSourceSet(): void {
    this.forget((entry) => entry.kind === "pending");
    this.entries.push(...this.sourcePending.values());
    this.sourcePending.clear();
  }

  /** Only a completed reconcile can prune unobserved image failures. Suffix notices follow ownership. */
  public closeReconcile(managed: readonly ManagedEmote[]): void {
    const live = new Set(managed.map((emote) => emote.sevenTvEmoteId));
    this.entries = this.entries.filter((entry) => {
      if (ProblemLedger.isImageFailure(entry)) return this.observed.has(entry);
      if (entry.kind === "renamed-with-suffix") return entry.sevenTvEmoteId !== undefined && live.has(entry.sevenTvEmoteId);
      return true;
    });
    this.observed.clear();
  }

  private forget(predicate: (entry: Problem) => boolean): void {
    this.entries = this.entries.filter((entry) => {
      if (!predicate(entry)) return true;
      this.observed.delete(entry);
      return false;
    });
  }

  private static isImageFailure(entry: Problem): boolean {
    return entry.kind === "skipped" || entry.kind === "too-large";
  }

  private static sameSubject(a: Problem, b: Problem): boolean {
    return a.kind === b.kind && a.sevenTvEmoteId === b.sevenTvEmoteId &&
      (a.sevenTvEmoteId !== undefined || a.message === b.message);
  }
}
