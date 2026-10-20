/**
 * `planLedger` — the attribution rules that turn a git walk into ledger rows, and
 * the deferral that names what it could not attribute. Pure, so each rule is
 * pinned directly rather than inferred from a DB-backed run.
 */
import { describe, expect, test } from "bun:test";
import { planLedger, type LedgerState } from "./plan";
import type { TrailerCommit } from "../../../core";

function commit(overrides: Partial<TrailerCommit> = {}): TrailerCommit {
  return {
    sha: "sha1",
    committedAt: new Date("2026-08-17T10:00:00Z"),
    conversationId: "conv-1",
    pushId: "push-a",
    subject: "feat: something",
    ...overrides,
  };
}

function state(overrides: Partial<LedgerState> = {}): LedgerState {
  return {
    have: new Set(),
    attemptByConversation: new Map([["conv-1", "att-1"]]),
    liveAttempts: new Set(["att-1"]),
    ...overrides,
  };
}

describe("planLedger", () => {
  test("attributes a commit to its conversation's attempt", () => {
    const { rows, deferred } = planLedger([commit()], state());
    expect(rows).toEqual([
      {
        id: "push-a:sha1",
        attemptId: "att-1",
        conversationId: "conv-1",
        sha: "sha1",
        pushId: "push-a",
        message: "feat: something",
        createdAt: new Date("2026-08-17T10:00:00Z"),
      },
    ]);
    expect(deferred).toEqual([]);
  });

  // The walk is newest-first; a push's commits must reach `pushes.landed`
  // subscribers in the order `main` recorded them.
  test("emits oldest first, reversing the walk", () => {
    const { rows } = planLedger(
      [commit({ sha: "newest" }), commit({ sha: "oldest" })],
      state(),
    );
    expect(rows.map((r) => r.sha)).toEqual(["oldest", "newest"]);
  });

  // Idempotence layer one: re-running a walk over commits already recorded is a
  // no-op before any write is attempted — and a covered commit is not a deferral.
  test("skips a commit the ledger already holds", () => {
    const { rows, deferred } = planLedger(
      [commit({ sha: "known" }), commit({ sha: "fresh" })],
      state({ have: new Set(["known"]) }),
    );
    expect(rows.map((r) => r.sha)).toEqual(["fresh"]);
    expect(deferred).toEqual([]);
  });

  // A worktree database forked before that conversation existed has nothing to
  // attach the push to — writing a row would break the FK. But the caller must
  // learn it happened, because an adoption can make the same commit attributable
  // later; hence `deferred` rather than a silent drop.
  test("defers a commit whose conversation is absent from this database", () => {
    const { rows, deferred } = planLedger(
      [commit({ conversationId: "conv-unknown" })],
      state(),
    );
    expect(rows).toEqual([]);
    expect(deferred.map((c) => c.conversationId)).toEqual(["conv-unknown"]);
  });

  test("defers a commit whose attempt is absent from this database", () => {
    const { rows, deferred } = planLedger(
      [commit()],
      state({ liveAttempts: new Set(["att-other"]) }),
    );
    expect(rows).toEqual([]);
    expect(deferred.map((c) => c.sha)).toEqual(["sha1"]);
  });

  // The adoption case the watermark used to lose: the very same commit, deferred
  // while the conversation was unknown here, becomes a row once
  // its conversation row has appeared. Nothing about the commit
  // changed — only this database's attribution set did.
  test("a deferred commit becomes a row once its conversation exists here", () => {
    const landed = commit({ sha: "adopted", conversationId: "conv-orphan" });
    const before = planLedger([landed], state());
    expect(before.rows).toEqual([]);
    expect(before.deferred).toEqual([landed]);

    const after = planLedger(
      [landed],
      state({
        attemptByConversation: new Map([["conv-orphan", "att-2"]]),
        liveAttempts: new Set(["att-2"]),
      }),
    );
    expect(after.deferred).toEqual([]);
    expect(after.rows.map((r) => r.sha)).toEqual(["adopted"]);
    expect(after.rows[0]!.attemptId).toBe("att-2");
  });

  test("keys the row on (pushId, sha), so one push spans many commits", () => {
    const { rows } = planLedger(
      [commit({ sha: "a" }), commit({ sha: "b" })],
      state(),
    );
    expect(rows.map((r) => r.id)).toEqual(["push-a:b", "push-a:a"]);
    expect(new Set(rows.map((r) => r.pushId))).toEqual(new Set(["push-a"]));
  });

  test("an empty walk plans nothing", () => {
    expect(planLedger([], state())).toEqual({ rows: [], deferred: [] });
  });
});
