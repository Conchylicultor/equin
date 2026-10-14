/**
 * Tests for the pure overlay/replay logic of the optimistic-mutation primitive.
 * Run with `bun test plugins/primitives/plugins/optimistic-mutation/web/internal`.
 *
 * The hook (`use-optimistic-resource.ts`) is a thin React shell over these
 * functions; the WHOLE op lifecycle (dispatch → resolve/fail → confirm →
 * deny/stall) lives here, so testing them directly exercises the load-bearing
 * invariants (ordered replay, base rebase, both confirmation edges, the
 * ordering rule that keeps the fold intact, causal denial under the watermark
 * rules, the stalled-report-only miss latch, failed-op immunity,
 * throwing-apply drop) without a render.
 */

import { test, expect, describe } from "bun:test";
import {
  ackPass,
  clearFailure,
  confirmPass,
  DIVERGENCE_REPORT_MISSES,
  markFailed,
  markResolved,
  markSent,
  OpNoLongerApplies,
  classifyRejection,
  rejectOp,
  replay,
  resolvePass,
  type OpFailure,
  type PendingOp,
} from "./overlay";

// A toy domain: an ordered list of numbers; ops push or remove a number.
type Vars = { kind: "push"; n: number } | { kind: "remove"; n: number };

function applyNums(current: number[], vars: Vars): number[] {
  if (vars.kind === "push") return [...current, vars.n];
  return current.filter((x) => x !== vars.n);
}

function op(
  opId: string,
  vars: Vars,
  resolved = false,
  extra: {
    dispatchGen?: number;
    misses?: number;
    ackWatermark?: string;
    failure?: OpFailure;
    divergenceReported?: boolean;
  } = {},
): PendingOp<Vars> {
  return {
    opId,
    vars,
    resolved,
    dispatchGen: extra.dispatchGen ?? 0,
    misses: extra.misses ?? 0,
    divergenceReported: extra.divergenceReported ?? false,
    dispatchedAt: 0,
    attempts: 0,
    ...(extra.ackWatermark !== undefined
      ? { ackWatermark: extra.ackWatermark }
      : {}),
    ...(extra.failure !== undefined ? { failure: extra.failure } : {}),
  };
}

/** The `performance.now()` stamp every test resolve happens at. */
const ACKED_AT = 1000;

/** Content-based confirmation for the toy domain: "is `n` present as expected?" */
const isConfirmedBy = (serverData: number[], vars: Vars): boolean =>
  vars.kind === "push"
    ? serverData.includes(vars.n)
    : !serverData.includes(vars.n);
/** Ops on the same number write the same "entity". */
const sameN = (a: Vars, b: Vars): boolean => a.n === b.n;
const content = { isConfirmedBy, sameTarget: sameN };

const ids = (ops: ReadonlyArray<PendingOp<Vars>>): string[] =>
  ops.map((o) => o.opId);

describe("replay", () => {
  test("(1) multiple in-flight ops compose in insertion order", () => {
    const base = [1];
    const pending = [
      op("a", { kind: "push", n: 2 }),
      op("b", { kind: "push", n: 3 }),
      op("c", { kind: "remove", n: 1 }),
    ];
    expect(replay(base, pending, applyNums)).toEqual([2, 3]);
  });

  test("order matters: a remove before its push is a no-op, after it removes", () => {
    const base: number[] = [];
    // remove(9) first (nothing to remove), then push(9) ⇒ [9]
    expect(
      replay(
        base,
        [op("a", { kind: "remove", n: 9 }), op("b", { kind: "push", n: 9 })],
        applyNums,
      ),
    ).toEqual([9]);
    // push(9) first, then remove(9) ⇒ []
    expect(
      replay(
        base,
        [op("a", { kind: "push", n: 9 }), op("b", { kind: "remove", n: 9 })],
        applyNums,
      ),
    ).toEqual([]);
  });

  test("(2) an interleaved authoritative base change replays remaining pending ops on the new base", () => {
    // Two ops pending. The server pushes a new base (someone else added 7).
    // The still-pending ops must replay on that fresh base, not the old one.
    const pending = [
      op("a", { kind: "push", n: 2 }),
      op("b", { kind: "push", n: 3 }),
    ];
    const oldBase = [1];
    expect(replay(oldBase, pending, applyNums)).toEqual([1, 2, 3]);

    const newBase = [1, 7]; // authoritative push interleaved
    expect(replay(newBase, pending, applyNums)).toEqual([1, 7, 2, 3]);
  });

  test("(5) an op that throws OpNoLongerApplies is dropped, keeps the rest", () => {
    const base = [1];
    const staleApply = (current: number[], vars: Vars): number[] => {
      if (vars.kind === "push" && vars.n === 999) {
        throw new OpNoLongerApplies();
      }
      return applyNums(current, vars);
    };
    const pending = [
      op("a", { kind: "push", n: 2 }),
      op("b", { kind: "push", n: 999 }), // stale ⇒ dropped from the fold
      op("c", { kind: "push", n: 3 }),
    ];
    // 999 is dropped; 2 and 3 still applied in order on the un-mutated acc.
    expect(replay(base, pending, staleApply)).toEqual([1, 2, 3]);
  });

  test("(5b) any OTHER throw is a reducer bug and propagates (fail loudly)", () => {
    const base = [1];
    const buggyApply = (current: number[], vars: Vars): number[] => {
      if (vars.kind === "push" && vars.n === 999) throw new Error("boom");
      return applyNums(current, vars);
    };
    const pending = [
      op("a", { kind: "push", n: 2 }),
      op("b", { kind: "push", n: 999 }), // generic Error ⇒ must NOT be swallowed
    ];
    expect(() => replay(base, pending, buggyApply)).toThrow("boom");
  });
});

describe("failure (markFailed / clearFailure) — never a rollback", () => {
  test("a rejected op STAYS in the overlay and keeps replaying (never-revert)", () => {
    const base = [1];
    const pending = [
      op("a", { kind: "push", n: 2 }),
      op("b", { kind: "push", n: 99 }), // this one will reject
      op("c", { kind: "push", n: 3 }),
    ];
    const afterReject = markFailed(pending, "b", { kind: "http", status: 422 });
    expect(ids(afterReject)).toEqual(["a", "b", "c"]);
    expect(afterReject[1]!.failure).toEqual({ kind: "http", status: 422 });
    // The failed op's prediction is still rendered — failure is a sync-status
    // state (cloud icon), not an undo.
    expect(replay(base, afterReject, applyNums)).toEqual([1, 2, 99, 3]);
  });

  test("clearFailure removes only the failure, keeping the op in place", () => {
    const pending = markFailed(
      [op("a", { kind: "push", n: 2 }), op("b", { kind: "push", n: 3 })],
      "a",
      { kind: "network" },
    );
    const cleared = clearFailure(pending, "a");
    expect(ids(cleared)).toEqual(["a", "b"]);
    expect(cleared[0]!.failure).toBeUndefined();
    expect(cleared[0]!.resolved).toBe(false); // still awaiting its (re-fired) mutate
  });

  test("markFailed / clearFailure are no-ops for an absent opId", () => {
    const pending = [op("a", { kind: "push", n: 2 })];
    expect(markFailed(pending, "missing", { kind: "network" })).toEqual(
      pending,
    );
    expect(clearFailure(pending, "missing")).toEqual(pending);
  });

  test("rejectOp removes only the rejected op; its successors replay on", () => {
    const pending = [
      op("a", { kind: "push", n: 2 }),
      op("b", { kind: "push", n: 99 }), // permanently rejected
      op("c", { kind: "push", n: 3 }),
    ];
    const next = rejectOp(pending, "b");
    expect(ids(next)).toEqual(["a", "c"]);
    expect(replay([1], next, applyNums)).toEqual([1, 2, 3]);
    expect(rejectOp(pending, "missing")).toBe(pending); // identity when absent
  });

  test("rejecting a parked junior's senior lets the junior leave on the next snapshot", () => {
    // The stuck-collapse shape: the senior's prediction was refused, so while
    // it stayed parked the junior (already reflected on the server) could
    // never confirm. Removing the senior un-parks it.
    const pending = [
      op("senior", { kind: "remove", n: 9 }),
      op("junior", { kind: "push", n: 9 }, true),
    ];
    expect(ids(confirmPass(pending, [1, 9], "999", content).pending)).toEqual([
      "senior",
      "junior",
    ]);
    const after = rejectOp(pending, "senior");
    expect(confirmPass(after, [1, 9], "999", content).pending).toEqual([]);
  });

  test("classifyRejection: a 4xx is final, except 401 / 408 / 429; 5xx is transient", () => {
    for (const status of [400, 403, 404, 409, 410, 422])
      expect(classifyRejection(status)).toBe("permanent");
    for (const status of [401, 408, 429, 500, 502, 503])
      expect(classifyRejection(status)).toBe("transient");
  });

  test("failed ops are immune to confirm / denial / miss counting", () => {
    // A failed op is UNRESOLVED (its mutate rejected), so no snapshot may touch
    // it: not confirmable (even when the snapshot happens to match its content),
    // never causally denied (even with a token the snapshot is past), never
    // miss-counted. It keeps replaying — that IS the never-revert policy.
    const failedOp = op("failed", { kind: "push", n: 9 }, false, {
      failure: { kind: "network" },
      ackWatermark: "100", // stale token from a PRIOR attempt — must not enable denial
    });
    const unrelated = op("unrelated", { kind: "push", n: 3 }, true); // other target, confirmed
    const next = confirmPass([failedOp, unrelated], [1, 3, 9], "500", content);
    expect(ids(next.pending)).toEqual(["failed"]);
    expect(next.pending[0]!.misses).toBe(0);
    expect(next.dropped).toEqual([]);
    expect(next.stalled).toEqual([]);
  });
});

describe("confirmPass (coarse)", () => {
  test("(4) tokenless coarse clears a resolved op after a push, keeps in-flight ops", () => {
    const pending = [
      op("a", { kind: "push", n: 2 }, true), // resolved ⇒ a push confirms it
      op("b", { kind: "push", n: 3 }, false), // still in flight ⇒ kept
    ];
    const serverData = [1, 2]; // server now reflects op a
    const next = confirmPass(pending, serverData, undefined);
    expect(ids(next.pending)).toEqual(["b"]);
    expect(next.dropped).toEqual([]);
    expect(next.stalled).toEqual([]);
  });

  test("unresolved ops are never dropped, even on a push", () => {
    const pending = [op("a", { kind: "push", n: 2 }, false)];
    const next = confirmPass(pending, [1, 2], undefined);
    expect(ids(next.pending)).toEqual(["a"]);
    // Nothing changed ⇒ the SAME array reference comes back (the shell's bail-out).
    expect(next.pending).toBe(pending);
  });

  test("tokenless coarse never accrues misses (every resolved op is confirmed)", () => {
    const pending = [op("a", { kind: "push", n: 2 }, true)];
    const next = confirmPass(pending, [1], undefined); // snapshot doesn't even contain 2
    expect(next.pending).toEqual([]);
    expect(next.stalled).toEqual([]);
  });

  test("coarse + token: confirmed only by a snapshot causally PAST the commit", () => {
    const pending = [
      op("a", { kind: "push", n: 2 }, true, { ackWatermark: "100" }),
    ];
    // Snapshot watermark at the commit itself (equal) — not past it: kept, one miss.
    const atCommit = confirmPass(pending, [1, 2], "100", undefined);
    expect(ids(atCommit.pending)).toEqual(["a"]);
    expect(atCommit.pending[0]!.misses).toBe(1);
    // No watermark seen yet — no causal floor: kept.
    const noFloor = confirmPass(pending, [1, 2], undefined, undefined);
    expect(ids(noFloor.pending)).toEqual(["a"]);
    // Strictly past the commit: confirmed (exact causal coarse confirmation).
    const past = confirmPass(pending, [1, 2], "101", undefined);
    expect(past.pending).toEqual([]);
    expect(past.dropped).toEqual([]);
  });

  test("coarse + token compares causally (BigInt), never lexicographically", () => {
    // "9" < "10" as xid8 values, though "9" > "10" as strings.
    const pending = [
      op("a", { kind: "push", n: 2 }, true, { ackWatermark: "9" }),
    ];
    expect(confirmPass(pending, [1, 2], "10", undefined).pending).toEqual([]);
  });

  test("coarse mode NEVER denies, even with a token the snapshot is past", () => {
    // Coarse has no isConfirmedBy to attest "the snapshot lacks my effect", so
    // a causally-later snapshot can only CONFIRM — dropping into `dropped`
    // (superseded) is content-mode-only.
    const pending = [
      op("a", { kind: "push", n: 2 }, true, { ackWatermark: "100" }),
    ];
    const next = confirmPass(pending, [1], "500", undefined);
    expect(next.pending).toEqual([]); // confirmed (cmp > 0), not denied
    expect(next.dropped).toEqual([]);
  });
});

describe("confirmPass (content-based isConfirmedBy)", () => {
  // Op identity is per-target: ops on the same number are "the same target".
  // `sameTarget` is required alongside `isConfirmedBy`, so content-based mode
  // is always the `{ isConfirmedBy, sameTarget }` pair. It is the ORDERING
  // RULE's relation ("may this op leave yet?"), never a licence to drop one op
  // on another's evidence.

  test("only drops a resolved op when isConfirmedBy accepts the snapshot", () => {
    const pushOnly = {
      isConfirmedBy: (s: number[], v: Vars) =>
        v.kind === "push" && s.includes(v.n),
      sameTarget: sameN,
    };
    const pending = [
      op("a", { kind: "push", n: 2 }, true),
      op("b", { kind: "push", n: 3 }, true),
    ];

    // Server only reflects 2 so far ⇒ a is confirmed, b is not.
    expect(
      ids(confirmPass(pending, [1, 2], undefined, pushOnly).pending),
    ).toEqual(["b"]);
    // Server reflects both ⇒ both dropped.
    expect(
      confirmPass(pending, [1, 2, 3], undefined, pushOnly).pending,
    ).toEqual([]);
    // Server reflects neither ⇒ both kept (each with one miss).
    expect(ids(confirmPass(pending, [1], undefined, pushOnly).pending)).toEqual(
      ["a", "b"],
    );
  });

  test("the stuck-inverse pair WAITS for a causal frame instead of collapsing", () => {
    // The stuck-inverse-pair scenario: undo removes 9 (resolved), redo pushes 9
    // back (resolved) before any push carrying the removal arrives. The eventual
    // snapshot shows 9 present — it confirms the redo but can never confirm the
    // undo by content.
    //
    // Cascade used to absorb the undo here. It no longer does (evicting the
    // OLDER op on the NEWER one's evidence re-composes the fold), so the pair
    // simply waits: the redo is blocked behind the undo, both replay, and the
    // render is correct throughout the wait.
    const pending = [
      op("undo", { kind: "remove", n: 9 }, true, { ackWatermark: "100" }),
      op("redo", { kind: "push", n: 9 }, true),
    ];
    const waiting = confirmPass(pending, [1, 9], undefined, content); // no causal floor
    expect(ids(waiting.pending)).toEqual(["undo", "redo"]);
    expect(waiting.dropped).toEqual([]);
    expect(replay([1, 9], waiting.pending, applyNums)).toEqual([1, 9]); // 9 stays present

    // It drains on the first watermark-carrying frame past the undo's commit:
    // Rule B denies the undo, the redo is then unblocked and content-confirms,
    // and the denial is self-supersession ⇒ reported to nobody.
    const drained = confirmPass(waiting.pending, [1, 9], "500", content);
    expect(drained.pending).toEqual([]);
    expect(drained.dropped).toEqual([]);
    expect(drained.stalled).toEqual([]);
  });

  test("an older resolved op on an UNRELATED target is never dropped or blocked", () => {
    const pushOnly = {
      isConfirmedBy: (s: number[], v: Vars) =>
        v.kind === "push" && s.includes(v.n),
      sameTarget: sameN,
    };
    // Two independent entities: op "a" writes 2, op "b" writes 3. Both resolved;
    // the NEWER one's confirming push arrives first (snapshot has 3, not 2).
    // "a" must survive until its own push lands — dropping it would transiently
    // revert its entity to stale server data.
    const pending = [
      op("a", { kind: "push", n: 2 }, true), // resolved, not yet reflected
      op("b", { kind: "push", n: 3 }, true), // confirmed by this snapshot
    ];
    expect(
      ids(confirmPass(pending, [1, 3], undefined, pushOnly).pending),
    ).toEqual(["a"]);
    // ...and the eventual push reflecting 2 confirms it normally.
    expect(
      confirmPass(pending, [1, 2, 3], undefined, pushOnly).pending,
    ).toEqual([]);
  });

  test("an UNRESOLVED older op survives AND blocks its newer same-target sibling", () => {
    // An in-flight op is still IN the fold, so a newer op composed on top of it
    // may not leave ahead of it — confirmed or not. (Dropping "b" here would
    // render a(base) instead of b(a(base)): the fold hole, through the content
    // door.) The unresolved op itself is untouchable as ever.
    const pushOnly = {
      isConfirmedBy: (s: number[], v: Vars) =>
        v.kind === "push" && s.includes(v.n),
      sameTarget: sameN,
    };
    const pending = [
      op("a", { kind: "remove", n: 3 }, false), // still in flight
      op("b", { kind: "push", n: 3 }, true), // content-confirmed by the snapshot
    ];
    const next = confirmPass(pending, [1, 3], undefined, pushOnly);
    expect(ids(next.pending)).toEqual(["a", "b"]);
    expect(next.pending).toBe(pending); // nothing changed at all ⇒ identity
    expect(next.pending[1]!.misses).toBe(0); // blocked ⇒ no miss
    expect(replay([1, 3], next.pending, applyNums)).toEqual([1, 3]);
  });

  test("a newer unconfirmed resolved op is left alone when its older sibling confirms", () => {
    const pushOnly = {
      isConfirmedBy: (s: number[], v: Vars) =>
        v.kind === "push" && s.includes(v.n),
      sameTarget: sameN,
    };
    const pending = [
      op("a", { kind: "push", n: 2 }, true), // confirmed
      op("b", { kind: "remove", n: 2 }, true), // same target, newer, not yet reflected — kept
    ];
    expect(
      ids(confirmPass(pending, [1, 2], undefined, pushOnly).pending),
    ).toEqual(["b"]);
  });
});

describe("the ordering rule (an ordered fold admits no transitive eviction)", () => {
  // The overlay is `pending.reduce(apply, base)`. An op's rendered effect is
  // defined RELATIVE to the ops before it, so removing a middle element
  // re-composes the fold and renders a state the user never created. Hence: an
  // op may not LEAVE while an older, still-surviving, same-target op remains —
  // whatever evidence exists about the newer op itself.

  test("(the incident) a vacuously-confirmed newer op cannot evict the older create", () => {
    // 2026-09-01: a block vanished mid-typing. The shape, in the toy domain:
    //  - "split" creates row 5. The snapshot is stale and genuinely lacks it.
    //  - "projection" is the debounced text write on an INTERSECTING target
    //    (the split writes {parent, new}, the projection writes {new}). Its
    //    predicate excludes the field it writes, so it answers `true` against
    //    ANY snapshot, including one that never saw it — it failed to
    //    CONTRADICT the op, which is not the same as reflecting it.
    // Cascade absorbed the split on that non-evidence and the create vanished.
    // Now the projection is simply blocked, and both keep replaying.
    const incident = {
      isConfirmedBy: (s: number[], v: Vars) =>
        v.n === 6 ? true : s.includes(v.n),
      sameTarget: () => true, // intersecting target sets
    };
    const pending = [
      op("split", { kind: "push", n: 5 }, true),
      op("projection", { kind: "push", n: 6 }, true),
    ];
    const stale = [1];
    const next = confirmPass(pending, stale, undefined, incident);
    expect(ids(next.pending)).toEqual(["split", "projection"]);
    expect(next.dropped).toEqual([]);
    expect(next.pending[0]!.misses).toBe(1); // the front of the chain IS evaluated
    expect(next.pending[1]!.misses).toBe(0); // the blocked op is not
    // The user's block is still on screen.
    expect(replay(stale, next.pending, applyNums)).toEqual([1, 5, 6]);
  });

  test("case 3 (delete X then create X), all three watermark rows", () => {
    // A = delete 9 (ack 100), B = create 9 (ack 110), both resolved. Whatever
    // the snapshot, 9 must be present in the render.
    const a = op("delete", { kind: "remove", n: 9 }, true, {
      ackWatermark: "100",
    });
    const b = op("create", { kind: "push", n: 9 }, true, {
      ackWatermark: "110",
    });
    const pending = [a, b];

    // Row 1 — W=50, before either commit: the snapshot still shows 9, so A is
    // unconfirmed and undeniable ⇒ it blocks B. Both replay.
    const early = confirmPass(pending, [1, 9], "50", content);
    expect(ids(early.pending)).toEqual(["delete", "create"]);
    expect(early.dropped).toEqual([]);
    expect(replay([1, 9], early.pending, applyNums)).toEqual([1, 9]);

    // Row 2 — W=105 (past A, before B) and 9 absent: A content-confirms and
    // leaves, so it no longer blocks; B is unconfirmed and replays.
    const middle = confirmPass(pending, [1], "105", content);
    expect(ids(middle.pending)).toEqual(["create"]);
    expect(middle.dropped).toEqual([]);
    expect(replay([1], middle.pending, applyNums)).toEqual([1, 9]);

    // Row 3 — W=150 (past both) and 9 present: A is denied (Rule B) and B
    // content-confirms, so both leave together and the base is already right.
    const late = confirmPass(pending, [1, 9], "150", content);
    expect(late.pending).toEqual([]);
    expect(late.dropped).toEqual([]); // self-supersession ⇒ no report
    expect(replay([1, 9], late.pending, applyNums)).toEqual([1, 9]);
  });

  test("(3) an exact ack cannot let an op out while an older sibling waits", () => {
    // hasAck is the strongest confirmation there is, and it still does not
    // license leaving out of turn: it proves this commit's rows were re-read,
    // and says nothing about the older op folded underneath.
    const ackOnly = (txid: string) => txid === "200";
    const pending = [
      op("a", { kind: "remove", n: 9 }, true, { ackWatermark: "100" }), // unconfirmable + undeniable
      op("b", { kind: "push", n: 9 }, true, { ackWatermark: "200" }), // acked
    ];
    const next = confirmPass(pending, [1, 9], undefined, content, ackOnly); // no snapshot watermark
    expect(ids(next.pending)).toEqual(["a", "b"]);
    expect(next.pending[1]!.misses).toBe(0);
    expect(replay([1, 9], next.pending, applyNums)).toEqual([1, 9]);
  });

  test("(4) blocking asks nothing about the older op's tokens", () => {
    // Same as above with a completely tokenless older sibling: it can neither
    // confirm nor be denied, and it still blocks. (This is the case an
    // absorb-on-token-order rule would strand, which is why the rule blocks.)
    const ackOnly = (txid: string) => txid === "200";
    const pending = [
      op("a", { kind: "remove", n: 9 }, true), // no ackWatermark at all
      op("b", { kind: "push", n: 9 }, true, { ackWatermark: "200" }),
    ];
    const next = confirmPass(pending, [1, 9], "999", content, ackOnly);
    expect(ids(next.pending)).toEqual(["a", "b"]);
    expect(next.dropped).toEqual([]);
    expect(replay([1, 9], next.pending, applyNums)).toEqual([1, 9]);
  });

  test("(5) an unresolved older op blocks its newer same-target sibling", () => {
    // "In flight" is a statement about the request, not about the fold: the op
    // is still in the overlay ahead of its junior, so dropping the junior would
    // break the composition exactly as a resolved older op would.
    const pending = [
      op("a", { kind: "remove", n: 9 }, false), // mutate still in flight
      op("b", { kind: "push", n: 9 }, true), // content-confirmed by this snapshot
    ];
    const next = confirmPass(pending, [1, 9], "999", content);
    expect(ids(next.pending)).toEqual(["a", "b"]);
    expect(next.pending).toBe(pending);
    expect(replay([1, 9], next.pending, applyNums)).toEqual([1, 9]);
  });

  test("(5b) an HTTP-failed op parks its juniors until the user retries", () => {
    // A failed op is unresolved by construction, so it is a survivor, so it
    // blocks. For a `network` failure that is brief (a reconnect edge
    // auto-retries). For a (transient) `http` failure awaiting an explicit
    // retry() it lasts as long as the user leaves it there — which is why a
    // PERMANENT rejection is never parked but removed (rejectOp, below). The
    // junior keeps RENDERING throughout and accrues no misses; the surface is
    // already showing `error` because of the failed op.
    const pending = markFailed(
      [
        op("failed", { kind: "remove", n: 9 }),
        op("junior", { kind: "push", n: 9 }, true), // resolved AND content-confirmed
      ],
      "failed",
      { kind: "http", status: 503 },
    );
    let cur: ReadonlyArray<PendingOp<Vars>> = pending;
    for (let i = 0; i < DIVERGENCE_REPORT_MISSES + 2; i++) {
      const next = confirmPass(cur, [1, 9], "999", content);
      expect(ids(next.pending)).toEqual(["failed", "junior"]);
      expect(next.pending).toBe(cur); // nothing moves, pass after pass
      expect(next.stalled).toEqual([]);
      expect(next.dropped).toEqual([]);
      cur = next.pending;
    }
    expect(cur[1]!.misses).toBe(0); // blocked ⇒ never charged a miss
    expect(replay([1, 9], cur, applyNums)).toEqual([1, 9]); // still rendered

    // Retry: clear the failure and re-fire. The resolve confirms the front op
    // (the snapshot shows 9 removed), which frees the junior in the SAME pass —
    // it is evaluated from here on, and its own next matching push clears it.
    const retried = resolvePass(
      clearFailure(cur, "failed"),
      "failed",
      ACKED_AT,
      [1],
      9,
      undefined,
      undefined,
      content,
    );
    expect(ids(retried.pending)).toEqual(["junior"]);
    expect(
      confirmPass(retried.pending, [1, 9], undefined, content).pending,
    ).toEqual([]);
  });

  test("(6) liveness: a same-target chain of 3 drains from the front", () => {
    // The oldest op on a target is never blocked (nothing is older), so every
    // chain drains front-first over successive passes — no deadlock is
    // spellable, because blocking only ever points older→newer over array order.
    let cur: ReadonlyArray<PendingOp<Vars>> = [
      op("o1", { kind: "push", n: 9 }, true, { ackWatermark: "100" }),
      op("o2", { kind: "remove", n: 9 }, true, { ackWatermark: "110" }),
      op("o3", { kind: "push", n: 9 }, true, { ackWatermark: "120" }),
    ];
    // Pass 1: the snapshot reflects o1 only ⇒ o1 confirms, o2 is evaluated
    // (unconfirmed, not yet deniable), o3 is blocked.
    cur = confirmPass(cur, [1, 9], "105", content).pending;
    expect(ids(cur)).toEqual(["o2", "o3"]);
    expect(cur[1]!.misses).toBe(0);
    // Pass 2: the snapshot reflects o2 ⇒ o2 confirms; o3 becomes the front.
    cur = confirmPass(cur, [1], "115", content).pending;
    expect(ids(cur)).toEqual(["o3"]);
    // Pass 3: o3 confirms. The overlay is empty — the chain drained completely.
    cur = confirmPass(cur, [1, 9], "125", content).pending;
    expect(cur).toEqual([]);
  });

  test("(7) a blocked op accrues no misses while the front of the chain stalls", () => {
    // A miss means "a fresh snapshot arrived and still doesn't reflect this op".
    // A pass we declined to EVALUATE is information-free, so counting it would
    // file a stalled report about a verdict that was never formed.
    let cur: ReadonlyArray<PendingOp<Vars>> = [
      op("front", { kind: "remove", n: 9 }, true), // tokenless ⇒ never denied
      op("back", { kind: "push", n: 9 }, true),
    ];
    let stalledCount = 0;
    for (let i = 0; i < DIVERGENCE_REPORT_MISSES + 2; i++) {
      const next = confirmPass(cur, [1, 9], "999", content);
      stalledCount += next.stalled.length;
      expect(next.dropped).toEqual([]);
      cur = next.pending;
      expect(ids(cur)).toEqual(["front", "back"]);
      expect(cur[0]!.misses).toBe(i + 1); // the front IS evaluated every pass
      expect(cur[1]!.misses).toBe(0); // the blocked op, never
    }
    expect(stalledCount).toBe(1); // exactly one report, from the front, latched
    expect(cur[1]!.divergenceReported).toBe(false);
  });

  test("(8) a denial with no confirmed same-target successor is still reported", () => {
    // The report suppression is narrow: it fires only for self-supersession (a
    // newer same-target op confirmed on this very pass). A denial whose
    // successor is merely unconfirmed is a genuine race and must still file.
    const pending = [
      op("a", { kind: "push", n: 9 }, true, { ackWatermark: "100" }),
      op("b", { kind: "push", n: 8 }, true), // different target — no bearing on a
    ];
    const next = confirmPass(pending, [1], "500", content);
    expect(ids(next.dropped)).toEqual(["a"]); // reported as `superseded`
    expect(ids(next.pending)).toEqual(["b"]);
  });

  test("(9) ops on unrelated targets neither block nor are blocked", () => {
    const pending = [
      op("older", { kind: "push", n: 2 }, true), // unconfirmed by this snapshot
      op("newer", { kind: "push", n: 3 }, true), // confirmed
    ];
    // The newer op leaves normally — nothing older writes ITS target.
    const forward = confirmPass(pending, [1, 3], undefined, content);
    expect(ids(forward.pending)).toEqual(["older"]);
    // ...and in the other order: the older op leaves and the newer one waits
    // for its own evidence, unaffected either way.
    const reversed = confirmPass(
      [pending[1]!, pending[0]!],
      [1, 3],
      undefined,
      content,
    );
    expect(ids(reversed.pending)).toEqual(["older"]);
  });
});

describe("causal denial (content mode + token — Rule B, strict >)", () => {
  // "deny" = the snapshot's watermark proves it saw the op's commit (or its
  // overwrite), yet isConfirmedBy still rejects it ⇒ the effect was overwritten
  // by newer server truth. The op is removed into `dropped` (superseded) —
  // rendering newer truth, never a revert.

  test("denied only under strict cmp(snapshotWm, ackWm) > 0", () => {
    const pending = [
      op("a", { kind: "push", n: 2 }, true, { ackWatermark: "100" }),
    ];
    const snapshot = [1]; // does NOT reflect the op

    // Snapshot older than the commit: a stale read, carries no evidence — kept.
    const older = confirmPass(pending, snapshot, "99", content);
    expect(ids(older.pending)).toEqual(["a"]);
    expect(older.dropped).toEqual([]);

    // Snapshot AT the commit (equal): not strictly past — kept.
    const equal = confirmPass(pending, snapshot, "100", content);
    expect(ids(equal.pending)).toEqual(["a"]);
    expect(equal.dropped).toEqual([]);

    // Snapshot strictly past the commit: provably superseded — dropped.
    const past = confirmPass(pending, snapshot, "101", content);
    expect(past.pending).toEqual([]);
    expect(ids(past.dropped)).toEqual(["a"]);
    expect(past.stalled).toEqual([]);
  });

  test("no snapshot watermark ⇒ no causal floor ⇒ never denied", () => {
    const pending = [
      op("a", { kind: "push", n: 2 }, true, { ackWatermark: "100" }),
    ];
    const next = confirmPass(pending, [1], undefined, content);
    expect(ids(next.pending)).toEqual(["a"]);
    expect(next.dropped).toEqual([]);
  });

  test("tokenless ops are NEVER denied — misses only ever trigger the stalled report", () => {
    const pending = [op("a", { kind: "push", n: 2 }, true)]; // no ackWatermark
    let cur = pending as ReadonlyArray<PendingOp<Vars>>;
    // Push far past any commit, many more times than the report threshold: the
    // op survives every single one (no eviction path exists for it).
    for (let i = 0; i < DIVERGENCE_REPORT_MISSES * 3; i++) {
      const next = confirmPass(cur, [1], "999999", content);
      expect(next.dropped).toEqual([]);
      expect(ids(next.pending)).toEqual(["a"]);
      cur = next.pending;
    }
    expect(cur[0]!.misses).toBe(DIVERGENCE_REPORT_MISSES * 3);
  });

  test("a cascade-superseded op is dropped silently, never denied/reported", () => {
    // "undo" would ALSO be deniable (token, snapshot past it) — but the cascade
    // claims it first: superseded by its own newer same-target sibling is the
    // healthy path and must not file a report.
    const pending = [
      op("undo", { kind: "remove", n: 9 }, true, { ackWatermark: "100" }),
      op("redo", { kind: "push", n: 9 }, true),
    ];
    const next = confirmPass(pending, [1, 9], "500", content);
    expect(next.pending).toEqual([]);
    expect(next.dropped).toEqual([]);
    expect(next.stalled).toEqual([]);
  });

  test("unresolved ops are never denied, token or not", () => {
    const pending = [
      op("a", { kind: "push", n: 2 }, false, { ackWatermark: "100" }),
    ];
    const next = confirmPass(pending, [1], "500", content);
    expect(ids(next.pending)).toEqual(["a"]);
    expect(next.dropped).toEqual([]);
  });

  test("a confirming snapshot wins over denial (content match is always safe)", () => {
    const pending = [
      op("a", { kind: "push", n: 2 }, true, { ackWatermark: "100" }),
    ];
    const next = confirmPass(pending, [1, 2], "500", content);
    expect(next.pending).toEqual([]);
    expect(next.dropped).toEqual([]); // confirmed, not denied
  });
});

describe("resolvePass (the resolve edge)", () => {
  test("content-based: a push that landed BEFORE the response still confirms the op", () => {
    // The measured production ordering: the confirming push arrives ~1ms before
    // the HTTP response. Under the old push-only confirmation the op sat
    // resolved-and-unconfirmed forever. Now the resolve edge re-asks the cache.
    const pending = [op("a", { kind: "push", n: 2 })];
    const next = resolvePass(
      pending,
      "a",
      ACKED_AT,
      [1, 2],
      1,
      undefined,
      undefined,
      content,
    );
    expect(next.pending).toEqual([]);
    expect(next.dropped).toEqual([]);
  });

  test("content-based: an unreflected snapshot keeps the op resolved, with NO miss", () => {
    // No new snapshot arrived, so a non-confirmation carries no evidence.
    const pending = [op("a", { kind: "push", n: 2 })];
    const next = resolvePass(
      pending,
      "a",
      ACKED_AT,
      [1],
      1,
      undefined,
      undefined,
      content,
    );
    expect(ids(next.pending)).toEqual(["a"]);
    expect(next.pending[0]!.resolved).toBe(true);
    expect(next.pending[0]!.misses).toBe(0);
  });

  test("content-based: no snapshot at all (serverData undefined) keeps the op", () => {
    const pending = [op("a", { kind: "push", n: 2 })];
    const next = resolvePass(
      pending,
      "a",
      ACKED_AT,
      undefined,
      0,
      undefined,
      undefined,
      content,
    );
    expect(ids(next.pending)).toEqual(["a"]);
    expect(next.pending[0]!.resolved).toBe(true);
    expect(next.pending[0]!.misses).toBe(0);
    expect(next.dropped).toEqual([]);
  });

  test("content-based: an op an EMPTY base would 'confirm' must not confirm on no snapshot", () => {
    // The stand-in-base hazard. `isConfirmedBy([], remove 9)` is TRUE — an
    // empty base vacuously reflects a removal. The caller must pass `undefined`
    // until an authoritative snapshot lands (the hook gates on
    // `dataUpdatedAt > 0`); were an empty stand-in passed through, this op would
    // be dropped as confirmed against data the server never sent. Same shape as the page editor's
    // `isReflected([], {kind:"remove"})` and its update-only `isPatchReflected`.
    expect(isConfirmedBy([], { kind: "remove", n: 9 })).toBe(true);

    const pending = [op("a", { kind: "remove", n: 9 })];
    const next = resolvePass(
      pending,
      "a",
      ACKED_AT,
      undefined,
      0,
      undefined,
      undefined,
      content,
    );
    expect(ids(next.pending)).toEqual(["a"]);
    expect(next.pending[0]!.misses).toBe(0);
    expect(next.dropped).toEqual([]);
  });

  test("content-based: the ordering rule gates the RESOLVE edge too", () => {
    // undo(remove 9) resolved and unconfirmed; redo(push 9) resolves now against
    // a snapshot showing 9 present. The resolve edge is an exit like any other,
    // so the redo may not take it while the older undo is still in the fold —
    // this is the resolve-edge half of the fold hole. Both survive; the render
    // stays correct.
    const pending = [
      op("undo", { kind: "remove", n: 9 }, true),
      op("redo", { kind: "push", n: 9 }),
    ];
    const next = resolvePass(
      pending,
      "redo",
      ACKED_AT,
      [1, 9],
      4,
      undefined,
      undefined,
      content,
    );
    expect(ids(next.pending)).toEqual(["undo", "redo"]);
    expect(next.pending[1]!.resolved).toBe(true); // still marked resolved
    expect(next.pending[1]!.misses).toBe(0); // blocked ⇒ no miss, ever
    expect(replay([1, 9], next.pending, applyNums)).toEqual([1, 9]);
  });

  test("resolvePass NEVER denies, even in content mode with a causally-past snapshot", () => {
    // A stuck older op with a token the current watermark is past: denial is a
    // push-edge-only verdict (no NEW snapshot arrived here).
    const pending = [
      op("stuck", { kind: "push", n: 2 }, true, { ackWatermark: "100" }),
      op("b", { kind: "push", n: 3 }),
    ];
    const next = resolvePass(
      pending,
      "b",
      ACKED_AT,
      [1],
      1,
      "500",
      undefined,
      content,
    );
    expect(ids(next.pending)).toEqual(["stuck", "b"]);
    expect(next.dropped).toEqual([]);
  });

  test("stamps the endpoint's ackWatermark on the resolving op", () => {
    const pending = [op("a", { kind: "push", n: 2 })];
    const next = resolvePass(
      pending,
      "a",
      ACKED_AT,
      [1],
      1,
      undefined,
      "123",
      content,
    );
    expect(next.pending[0]!.ackWatermark).toBe("123");
  });

  test("clears a prior failure — a retried op that succeeds is no longer failed", () => {
    const pending = markFailed([op("a", { kind: "push", n: 2 })], "a", {
      kind: "network",
    });
    const next = resolvePass(
      pending,
      "a",
      ACKED_AT,
      [1],
      1,
      undefined,
      undefined,
      content,
    );
    expect(next.pending[0]!.failure).toBeUndefined();
    expect(next.pending[0]!.resolved).toBe(true);
  });

  test("coarse + token: confirms iff the cached snapshot is causally past the commit", () => {
    const pending = [
      op("a", { kind: "push", n: 2 }, false, { dispatchGen: 7 }),
    ];
    // Snapshot watermark past the just-returned ack ⇒ the cached value already
    // contains this commit — confirmed, regardless of the generation counter.
    expect(
      resolvePass(pending, "a", ACKED_AT, [1, 2], 7, "101", "100").pending,
    ).toEqual([]);
    // Watermark at/older than the ack ⇒ kept (the gen stamp is NOT consulted
    // once a token exists — the token is strictly more precise).
    const kept = resolvePass(pending, "a", ACKED_AT, [1, 2], 8, "100", "100");
    expect(ids(kept.pending)).toEqual(["a"]);
    expect(kept.pending[0]!.resolved).toBe(true);
  });

  test("coarse tokenless: gen > dispatchGen confirms (a push landed since dispatch)", () => {
    const pending = [
      op("a", { kind: "push", n: 2 }, false, { dispatchGen: 7 }),
    ];
    expect(
      resolvePass(pending, "a", ACKED_AT, [1, 2], 8, undefined, undefined)
        .pending,
    ).toEqual([]);
  });

  test("coarse tokenless: gen === dispatchGen keeps the op (no push has landed yet)", () => {
    const pending = [
      op("a", { kind: "push", n: 2 }, false, { dispatchGen: 7 }),
    ];
    const next = resolvePass(
      pending,
      "a",
      ACKED_AT,
      [1, 2],
      7,
      undefined,
      undefined,
    );
    expect(ids(next.pending)).toEqual(["a"]);
    expect(next.pending[0]!.resolved).toBe(true);
    // ...and the next authoritative push confirms it coarsely.
    expect(confirmPass(next.pending, [1, 2], undefined).pending).toEqual([]);
  });

  test("only the resolving op is marked resolved; siblings are untouched", () => {
    const pending = [
      op("a", { kind: "push", n: 2 }, false, { dispatchGen: 1 }),
      op("b", { kind: "push", n: 3 }, false, { dispatchGen: 1 }),
    ];
    const next = resolvePass(
      pending,
      "b",
      ACKED_AT,
      [1],
      1,
      undefined,
      undefined,
    ); // coarse, gen === dispatchGen
    expect(next.pending.map((o) => [o.opId, o.resolved])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  test("an unknown opId is a no-op and returns the input by identity", () => {
    const pending = [op("a", { kind: "push", n: 2 })];
    const next = resolvePass(
      pending,
      "missing",
      ACKED_AT,
      [1],
      5,
      undefined,
      undefined,
      content,
    );
    expect(next.pending).toEqual(pending);
    expect(next.dropped).toEqual([]);
  });
});

describe("stalled reporting (miss counting — report-only, never evicts)", () => {
  test("each unconfirming push bumps a resolved op's miss count", () => {
    let pending: ReadonlyArray<PendingOp<Vars>> = [
      op("a", { kind: "push", n: 2 }, true),
    ];
    pending = confirmPass(pending, [1], undefined, content).pending;
    expect(pending[0]!.misses).toBe(1);
    pending = confirmPass(pending, [1], undefined, content).pending;
    expect(pending[0]!.misses).toBe(2);
  });

  test(`crossing ${DIVERGENCE_REPORT_MISSES} misses reports the op as stalled and KEEPS it`, () => {
    let pending: ReadonlyArray<PendingOp<Vars>> = [
      op("a", { kind: "push", n: 2 }, true),
      op("b", { kind: "push", n: 3 }, false), // unresolved — never accrues misses
    ];
    for (let i = 1; i < DIVERGENCE_REPORT_MISSES; i++) {
      const next = confirmPass(pending, [1], undefined, content);
      expect(next.stalled).toEqual([]);
      pending = next.pending;
    }
    const crossing = confirmPass(pending, [1], undefined, content);
    // The op is reported once AND stays in the overlay — no eviction, no revert.
    expect(ids(crossing.pending)).toEqual(["a", "b"]);
    expect(ids(crossing.stalled)).toEqual(["a"]);
    expect(crossing.stalled[0]!.misses).toBe(DIVERGENCE_REPORT_MISSES);
    expect(crossing.pending[0]!.divergenceReported).toBe(true);
    expect(crossing.pending[1]!.misses).toBe(0); // unresolved op untouched

    // The latch: further unconfirming pushes keep the op, report nothing more.
    const after = confirmPass(crossing.pending, [1], undefined, content);
    expect(ids(after.pending)).toEqual(["a", "b"]);
    expect(after.stalled).toEqual([]);
    expect(after.pending[0]!.misses).toBe(DIVERGENCE_REPORT_MISSES + 1);
  });

  test("a stalled (reported) op is still confirmable by a later matching snapshot", () => {
    // The whole point of never evicting: under push lag the misses were stale
    // snapshots; when the real one arrives the op confirms and leaves cleanly.
    const pending = [
      op("a", { kind: "push", n: 2 }, true, {
        misses: DIVERGENCE_REPORT_MISSES + 2,
        divergenceReported: true,
      }),
    ];
    const next = confirmPass(pending, [1, 2], undefined, content);
    expect(next.pending).toEqual([]);
    expect(next.stalled).toEqual([]);
    expect(next.dropped).toEqual([]);
  });

  test("a confirming push resets nothing — the op simply leaves before stalling", () => {
    let pending: ReadonlyArray<PendingOp<Vars>> = [
      op("a", { kind: "push", n: 2 }, true),
    ];
    pending = confirmPass(pending, [1], undefined, content).pending;
    expect(pending[0]!.misses).toBe(1);
    const next = confirmPass(pending, [1, 2], undefined, content);
    expect(next.pending).toEqual([]);
    expect(next.stalled).toEqual([]);
  });

  test("a self-superseded op leaves without a report, however many misses", () => {
    // "undo" has already missed LIMIT-1 pushes. This push is causally past its
    // commit and still shows 9 present ⇒ it is DENIED, and "redo" (same target,
    // newer) confirms on the same pass ⇒ the client superseded its own write.
    // Both leave, and neither `stalled` nor `superseded` is filed.
    const pending = [
      op("undo", { kind: "remove", n: 9 }, true, {
        misses: DIVERGENCE_REPORT_MISSES - 1,
        ackWatermark: "100",
      }),
      op("redo", { kind: "push", n: 9 }, true),
    ];
    const next = confirmPass(pending, [1, 9], "500", content);
    expect(next.pending).toEqual([]);
    expect(next.stalled).toEqual([]);
    expect(next.dropped).toEqual([]);
  });

  test("resolvePass never counts a miss, so it can never stall an op", () => {
    const pending = [
      op("a", { kind: "push", n: 2 }, true, {
        misses: DIVERGENCE_REPORT_MISSES - 1,
      }),
      op("b", { kind: "push", n: 3 }),
    ];
    const next = resolvePass(
      pending,
      "b",
      ACKED_AT,
      [1],
      1,
      undefined,
      undefined,
      content,
    );
    expect(next.stalled).toEqual([]);
    expect(next.pending[0]!.misses).toBe(DIVERGENCE_REPORT_MISSES - 1);
  });
});

describe("exact-ack confirmation (the ackTx registry probe)", () => {
  // `hasAck` is the registry-membership probe: "did the server broadcast this
  // op's commit txid in a frame's ackTx for my tuple?". It CONFIRMS exactly and
  // NEVER denies — denial stays snapshot-watermark-only (Rule B′ untouched).
  const ackOf =
    (...txids: string[]) =>
    (txid: string) =>
      txids.includes(txid);

  test("confirmPass coarse: an acked resolved op confirms even with NO snapshot watermark and an unreflected snapshot", () => {
    const pending = [
      op("a", { kind: "push", n: 2 }, true, { ackWatermark: "100" }),
    ];
    // Without the ack: kept (no causal floor), one miss.
    const unacked = confirmPass(pending, [1], undefined, undefined, ackOf());
    expect(ids(unacked.pending)).toEqual(["a"]);
    // With the ack: confirmed (dropped from pending, NOT into `dropped`).
    const acked = confirmPass(pending, [1], undefined, undefined, ackOf("100"));
    expect(acked.pending).toEqual([]);
    expect(acked.dropped).toEqual([]);
  });

  test("confirmPass content: the ack confirms an op isConfirmedBy rejects", () => {
    // "redo" is acked, so it confirms even though the snapshot [1] shows no 9.
    // It may take that exit only because the older same-target "undo" is ALSO
    // leaving on this pass — the snapshot genuinely reflects its removal, so it
    // content-confirms on its own evidence, and blocks nobody.
    const pending = [
      op("undo", { kind: "remove", n: 9 }, true),
      op("redo", { kind: "push", n: 9 }, true, { ackWatermark: "200" }),
    ];
    const next = confirmPass(pending, [1], undefined, content, ackOf("200"));
    expect(next.pending).toEqual([]);
    expect(next.dropped).toEqual([]);
    expect(next.stalled).toEqual([]);
  });

  test("resolvePass (both modes): the just-stamped token confirms when the registry already remembers it (delta-before-response race)", () => {
    // The frame carrying this commit's ackTx landed BEFORE the HTTP response —
    // the resolve edge probes the registry with the freshly-stamped token.
    const pending = [op("a", { kind: "push", n: 2 })];
    const contentNext = resolvePass(
      pending,
      "a",
      ACKED_AT,
      [1],
      1,
      undefined,
      "300",
      content,
      ackOf("300"),
    );
    expect(contentNext.pending).toEqual([]);
    const coarseNext = resolvePass(
      pending,
      "a",
      ACKED_AT,
      [1],
      1,
      undefined,
      "300",
      undefined,
      ackOf("300"),
    );
    expect(coarseNext.pending).toEqual([]);
    // Registry miss: unchanged from before (content: kept resolved, no miss).
    const missNext = resolvePass(
      pending,
      "a",
      ACKED_AT,
      [1],
      1,
      undefined,
      "300",
      content,
      ackOf(),
    );
    expect(ids(missNext.pending)).toEqual(["a"]);
  });

  test("ackPass drops acked resolved ops, counts NO miss, never denies, and returns the input by identity when nothing changed", () => {
    const pending = [
      op("acked", { kind: "push", n: 2 }, true, {
        ackWatermark: "400",
        misses: 1,
      }),
      op("other", { kind: "push", n: 3 }, true, {
        ackWatermark: "401",
        misses: 1,
      }),
      op("inflight", { kind: "push", n: 4 }, false, { ackWatermark: "400" }), // unresolved — untouchable
    ];
    const next = ackPass(pending, ackOf("400"), sameN);
    expect(ids(next.pending)).toEqual(["other", "inflight"]);
    expect(next.dropped).toEqual([]); // an ack never denies
    expect(next.stalled).toEqual([]);
    expect(next.pending[0]!.misses).toBe(1); // no miss counted on the ack edge

    // Nothing acked ⇒ the SAME array reference (the React shell's bail-out).
    const idle = ackPass(pending, ackOf(), sameN);
    expect(idle.pending).toBe(pending);
  });

  test("ackPass: an acked op is BLOCKED behind an older same-target survivor", () => {
    // (3) The ack fixture, and (4) the tokenless variant of it. This is the edge
    // the fold hole is widest on: a standalone ack frame is emitted exactly when
    // the recompute produced NO value change — "delete 9" then "create 9" — so
    // the cached snapshot beside it still shows the pre-undo world. Confirming
    // "redo" here and replaying "undo" alone would make 9 vanish from the
    // screen. Blocking gates the ack route like every other exit, and it asks
    // nothing about the older op's tokens: a tokenless older sibling blocks
    // just the same.
    const older = [
      op("undo", { kind: "remove", n: 9 }, true, { ackWatermark: "100" }),
      op("undoTokenless", { kind: "remove", n: 9 }, true), // no ackWatermark at all
    ];
    for (const undo of older) {
      const pending = [
        undo,
        op("redo", { kind: "push", n: 9 }, true, { ackWatermark: "500" }),
      ];
      const next = ackPass(pending, ackOf("500"), sameN);
      expect(ids(next.pending)).toEqual([undo.opId, "redo"]);
      expect(next.pending).toBe(pending); // nothing changed ⇒ identity
      expect(next.dropped).toEqual([]);
      expect(replay([1, 9], next.pending, applyNums)).toEqual([1, 9]); // 9 stays present
    }
  });

  test("tokenless ops are unaffected by every ack edge", () => {
    const pending = [op("a", { kind: "push", n: 2 }, true)]; // no ackWatermark
    expect(ackPass(pending, () => true).pending).toBe(pending);
    // …and the confirm passes don't consult hasAck for them either (content
    // mode: unreflected snapshot keeps the op with a miss, exactly as before).
    const next = confirmPass(pending, [1], undefined, content, () => true);
    expect(ids(next.pending)).toEqual(["a"]);
    expect(next.pending[0]!.misses).toBe(1);
  });

  test("denial stays watermark-only: an UN-acked op is denied by a causally-past snapshot exactly as before", () => {
    const pending = [
      op("a", { kind: "push", n: 2 }, true, { ackWatermark: "600" }),
    ];
    const next = confirmPass(pending, [1], "601", content, ackOf());
    expect(next.pending).toEqual([]);
    expect(ids(next.dropped)).toEqual(["a"]); // superseded — the ack registry played no part
  });
});

describe("markResolved", () => {
  test("marks the matching op resolved, preserves order and the rest", () => {
    const pending = [
      op("a", { kind: "push", n: 2 }),
      op("b", { kind: "push", n: 3 }),
    ];
    const next = markResolved(pending, "b", ACKED_AT);
    expect(next.map((o) => [o.opId, o.resolved])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  test("is a no-op when the opId is absent", () => {
    const pending = [op("a", { kind: "push", n: 2 })];
    expect(markResolved(pending, "missing", ACKED_AT)).toEqual(pending);
  });
});

describe("latency stamps (markSent / markResolved)", () => {
  test("markSent stamps the first send once, moves the last send, counts attempts", () => {
    const pending = [
      op("a", { kind: "push", n: 2 }),
      op("b", { kind: "push", n: 3 }),
    ];
    const once = markSent(pending, "b", 10);
    expect(once[0]).toBe(pending[0]); // other ops untouched
    expect(once[1]).toMatchObject({
      firstSentAt: 10,
      lastSentAt: 10,
      attempts: 1,
    });
    const twice = markSent(once, "b", 25); // a retry re-sends
    expect(twice[1]).toMatchObject({
      firstSentAt: 10,
      lastSentAt: 25,
      attempts: 2,
    });
    expect(markSent(pending, "missing", 10)).toEqual(pending);
  });

  test("markResolved stamps ackedAt; a re-resolve (retry) moves it", () => {
    const pending = [op("a", { kind: "push", n: 2 })];
    const first = markResolved(pending, "a", 50);
    expect(first[0]!.ackedAt).toBe(50);
    expect(markResolved(first, "a", 80)[0]!.ackedAt).toBe(80);
  });

  test("resolvePass stamps ackedAt on the op it reports confirmed", () => {
    const pending = [op("a", { kind: "push", n: 2 })];
    const next = resolvePass(
      pending,
      "a",
      77,
      [1, 2],
      1,
      undefined,
      undefined,
      content,
    );
    expect(next.confirmed.map((c) => c.op.ackedAt)).toEqual([77]);
  });
});

describe("confirmed (the confirm latency signal's input)", () => {
  const ackOf =
    (...txids: string[]) =>
    (txid: string) =>
      txids.includes(txid);
  const modes = (r: {
    confirmed: ReadonlyArray<{ op: PendingOp<Vars>; mode: string }>;
  }) => r.confirmed.map((c) => [c.op.opId, c.mode]);

  test("push edge: each confirmed op carries the mode that proved it", () => {
    // Coarse: exact ack, watermark, tokenless.
    const coarse = confirmPass(
      [
        op("ack", { kind: "push", n: 2 }, true, { ackWatermark: "300" }),
        op("wm", { kind: "push", n: 3 }, true, { ackWatermark: "100" }),
        op("tokenless", { kind: "push", n: 4 }, true),
        op("inflight", { kind: "push", n: 5 }),
      ],
      [1],
      "200",
      undefined,
      ackOf("300"),
    );
    expect(modes(coarse)).toEqual([
      ["ack", "exact-ack"],
      ["wm", "watermark"],
      ["tokenless", "tokenless"],
    ]);
    // Content: content and exact ack.
    const byContent = confirmPass(
      [
        op("c", { kind: "push", n: 2 }, true),
        op("x", { kind: "push", n: 7 }, true, { ackWatermark: "300" }),
      ],
      [1, 2],
      undefined,
      content,
      ackOf("300"),
    );
    expect(modes(byContent)).toEqual([
      ["c", "content"],
      ["x", "exact-ack"],
    ]);
  });

  test("denied and denied-silent ops are never in confirmed", () => {
    // "lost" is causally denied (snapshot 500 past its 100, still lacks 9).
    const denied = confirmPass(
      [op("lost", { kind: "push", n: 9 }, true, { ackWatermark: "100" })],
      [1],
      "500",
      content,
    );
    expect(ids(denied.dropped)).toEqual(["lost"]);
    expect(denied.confirmed).toEqual([]);
    // undo→redo: the undo is denied-silent, only the redo confirms.
    const selfSuperseded = confirmPass(
      [
        op("undo", { kind: "remove", n: 9 }, true, { ackWatermark: "100" }),
        op("redo", { kind: "push", n: 9 }, true, { ackWatermark: "110" }),
      ],
      [1, 9],
      "500",
      content,
    );
    expect(selfSuperseded.pending).toEqual([]);
    expect(selfSuperseded.dropped).toEqual([]);
    expect(modes(selfSuperseded)).toEqual([["redo", "content"]]);
  });

  test("blocked, pending and unconfirmed ops are never in confirmed; identity results carry none", () => {
    const pending = [
      op("a", { kind: "push", n: 9 }, true),
      op("b", { kind: "push", n: 9 }, true, { ackWatermark: "300" }), // acked but blocked behind a
      op("c", { kind: "push", n: 3 }),
    ];
    const next = ackPass(pending, ackOf("300"), sameN);
    expect(next.pending).toBe(pending);
    expect(next.confirmed).toEqual([]);
  });

  test("resolve edge: exact ack, content, watermark, tokenless", () => {
    const one = [op("a", { kind: "push", n: 2 }, false, { dispatchGen: 1 })];
    expect(
      modes(
        resolvePass(
          one,
          "a",
          ACKED_AT,
          [1],
          1,
          undefined,
          "100",
          content,
          ackOf("100"),
        ),
      ),
    ).toEqual([["a", "exact-ack"]]);
    expect(
      modes(
        resolvePass(
          one,
          "a",
          ACKED_AT,
          [1, 2],
          1,
          undefined,
          undefined,
          content,
        ),
      ),
    ).toEqual([["a", "content"]]);
    expect(
      modes(resolvePass(one, "a", ACKED_AT, [1], 1, "200", "100")),
    ).toEqual([["a", "watermark"]]);
    expect(
      modes(resolvePass(one, "a", ACKED_AT, [1], 2, undefined, undefined)),
    ).toEqual([["a", "tokenless"]]);
    // Not confirmed on this edge ⇒ nothing.
    expect(
      resolvePass(one, "a", ACKED_AT, [1], 1, undefined, undefined).confirmed,
    ).toEqual([]);
  });

  test("ack edge: exact ack", () => {
    const pending = [
      op("a", { kind: "push", n: 2 }, true, { ackWatermark: "100" }),
    ];
    expect(modes(ackPass(pending, ackOf("100")))).toEqual([["a", "exact-ack"]]);
  });
});

describe("integration: chained dispatch + interleaved push + failure", () => {
  test("two dispatches, a push confirming the first, then the second fails and retries", () => {
    const base = [1];
    let pending: ReadonlyArray<PendingOp<Vars>> = [];

    // dispatch a
    pending = [...pending, op("a", { kind: "push", n: 2 })];
    // dispatch b
    pending = [...pending, op("b", { kind: "push", n: 3 })];
    expect(replay(base, pending, applyNums)).toEqual([1, 2, 3]);

    // a's mutate resolves; b's REJECTS at the network level — b stays rendered.
    pending = resolvePass(
      pending,
      "a",
      ACKED_AT,
      base,
      0,
      undefined,
      undefined,
      content,
    ).pending;
    pending = markFailed(pending, "b", { kind: "network" });
    expect(replay(base, pending, applyNums)).toEqual([1, 2, 3]);

    // server push reflecting only a; b (failed ⇒ unresolved) is untouchable.
    const next = confirmPass(pending, [1, 2], undefined, content);
    expect(ids(next.pending)).toEqual(["b"]);
    expect(replay([1, 2], next.pending, applyNums)).toEqual([1, 2, 3]);

    // reconnect edge: retry in place — clear the failure, re-fire, resolve.
    pending = clearFailure(next.pending, "b");
    pending = resolvePass(
      pending,
      "b",
      ACKED_AT,
      [1, 2],
      1,
      undefined,
      undefined,
      content,
    ).pending;
    expect(ids(pending)).toEqual(["b"]); // resolved, awaiting its push
    expect(confirmPass(pending, [1, 2, 3], undefined, content).pending).toEqual(
      [],
    );
  });

  test("the push-before-resolve ordering: one dispatch, push, then resolve ⇒ empty overlay", () => {
    // The exact production trace: fetch sent at t=0, WS push at t=83ms (op still
    // unresolved ⇒ survives confirmPass), response at t=84ms. The resolve edge
    // must confirm against the already-arrived snapshot.
    let pending: ReadonlyArray<PendingOp<Vars>> = [
      op("a", { kind: "push", n: 2 }, false, { dispatchGen: 5 }),
    ];
    // The push: the op is unresolved, so nothing is dropped.
    const afterPush = confirmPass(pending, [1, 2], undefined, content);
    expect(ids(afterPush.pending)).toEqual(["a"]);
    pending = afterPush.pending;
    // The response: gen advanced to 6, and the snapshot already reflects the op.
    const afterResolve = resolvePass(
      pending,
      "a",
      ACKED_AT,
      [1, 2],
      6,
      undefined,
      undefined,
      content,
    );
    expect(afterResolve.pending).toEqual([]);
    // Tokenless coarse consumers get the same outcome via the gen stamp alone.
    expect(
      resolvePass(pending, "a", ACKED_AT, [1, 2], 6, undefined, undefined)
        .pending,
    ).toEqual([]);
  });

  test("the motivating bug: stale snapshots after the commit can never evict a split", () => {
    // Production trace pageId block-1783508240248-6o4jvk: a server-acked
    // `split` op saw 3 pushes whose snapshots were computed BEFORE the split
    // committed (push lag — delivery order is not causality). The old
    // miss-limit eviction dropped the op and the block vanished mid-typing.
    // Now: without a causal proof the op survives indefinitely (stalled report
    // only), and WITH a token, stale snapshots (watermark ≤ ack) still cannot
    // deny it — only a snapshot provably past the commit that lacks its effect
    // may drop it.
    const acked = op("split", { kind: "push", n: 2 }, true, {
      ackWatermark: "200",
    });
    let pending: ReadonlyArray<PendingOp<Vars>> = [acked];
    for (let i = 0; i < DIVERGENCE_REPORT_MISSES + 2; i++) {
      const next = confirmPass(pending, [1], "150", content); // stale: 150 < 200
      expect(next.dropped).toEqual([]);
      expect(ids(next.pending)).toEqual(["split"]);
      pending = next.pending;
    }
    // The real (causally-later) snapshot arrives carrying the split ⇒ confirmed.
    expect(confirmPass(pending, [1, 2], "201", content).pending).toEqual([]);
  });
});
