import { describe, expect, test } from "bun:test";
import { ProblemLedger } from "./problem-ledger.ts";
import { ServerState } from "./server-state.ts";
import { ManagedEmote } from "./slot-occupant.ts";
import type { Problem } from "./types.ts";

const imageFailure: Problem = { kind: "too-large", sevenTvEmoteId: "big", message: "Big was too large" };
const suffix: Problem = { kind: "renamed-with-suffix", sevenTvEmoteId: "renamed", message: "Another name was taken" };
const pending = (id: string): Problem => ({ kind: "pending", sevenTvEmoteId: id, message: `${id} is waiting` });

describe("the per-run problem ledger", () => {
  test("new, repeated and gone image failures", () => {
    const ledger = new ProblemLedger([]);
    expect(ledger.observe(imageFailure)).toBe(true);
    expect(ledger.observe(imageFailure)).toBe(false);
    ledger.closeReconcile([]);
    const next = new ProblemLedger(ledger.snapshot());
    expect(next.observeKnownImageFailure("big")).toBe(true);
    next.closeReconcile([]);
    expect(next.snapshot()).toEqual([imageFailure]);
    const gone = new ProblemLedger(next.snapshot());
    gone.closeReconcile([]);
    expect(gone.snapshot()).toEqual([]);
    expect(gone.observe(imageFailure)).toBe(true);
  });

  test("rebuilds pending in observation order only after a complete Source Set review", () => {
    const ledger = new ProblemLedger([pending("b"), pending("a"), pending("gone")]);
    expect(ledger.observeSourcePending("a", pending("a").message)).toBe(false);
    expect(ledger.observeSourcePending("c", pending("c").message)).toBe(true);
    expect(ledger.observeSourcePending("b", pending("b").message)).toBe(false);
    expect(ledger.snapshot()).toEqual([pending("b"), pending("a"), pending("gone")]);
    ledger.closeSourceSet();
    expect(ledger.snapshot()).toEqual([pending("a"), pending("c"), pending("b")]);
  });

  test("suffix notices follow a Managed Emote, including Requested Emotes", () => {
    const ledger = new ProblemLedger([suffix]);
    expect(ledger.observe(suffix)).toBe(false);
    ledger.closeReconcile([new ManagedEmote("id", "renamed", "requested", "static")]);
    expect(ledger.snapshot()).toEqual([suffix]);
    ledger.closeReconcile([]);
    expect(ledger.snapshot()).toEqual([]);
  });

  test("retains exactly the prior problem snapshot before any observations", () => {
    const existing = { ...ServerState.empty().toSnapshot(), problems: [pending("a"), imageFailure, suffix], extra: { future: true } };
    expect(ServerState.fromSnapshot(existing).toSnapshot()).toEqual(existing);
  });
});
