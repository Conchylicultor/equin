/**
 * The facts → context step, pure: the live value's followed rows and the SQL
 * read (`readAttemptFacts`) are two producers of ONE `AttemptFacts`, and the
 * measurement's context is a function of the facts alone — so the two paths
 * measure the same thing for the same database state. No git, no database:
 * the git half is `measure.test.ts`'s.
 */
import { describe, expect, test } from "bun:test";
import { attemptBranchRef } from "@plugins/infra/plugins/worktree/core";
import { attemptFactsFrom, contextFrom, type AttemptFacts } from "./work";

const ATTEMPT = "att-1-abc";
const CREATED = new Date("2026-10-01T12:00:00.000Z");

/** The attempt as its followed lookup row carries it (`attemptWorkspaces`). */
const followedAttempt = {
  id: ATTEMPT,
  workspace: { kind: "worktree" as const },
  worktreePath: "/wt/a",
  createdAt: CREATED,
};

describe("attempt facts", () => {
  test("the followed rows and the SQL read give one context", () => {
    // The follows: the conversation set in `createdAt` order, the push ids,
    // the delivery row — the rows as their collections carry them.
    const convRows = [
      { id: "conv-b", attemptId: ATTEMPT, createdAt: CREATED },
      { id: "conv-a", attemptId: ATTEMPT, createdAt: CREATED },
    ];
    const pushRows = [
      { id: "p1", attemptId: ATTEMPT, createdAt: CREATED },
      { id: "p2", attemptId: ATTEMPT, createdAt: CREATED },
    ];
    const fromFollows = attemptFactsFrom({
      attempt: [followedAttempt],
      convIds: convRows,
      pushIds: pushRows,
      delivery: [],
    });
    // The SQL read of the same state: the whole attempt row (every column),
    // the conversation ids in whatever order Postgres returns them.
    const attemptRow = {
      ...followedAttempt,
      taskId: "task-1",
      updatedAt: new Date(),
    };
    const fromSql: AttemptFacts = {
      attempt: attemptRow,
      convIds: ["conv-a", "conv-b"],
      ledgerPushes: 2,
      delivered: false,
    };
    expect(contextFrom(ATTEMPT, fromFollows)).toEqual(
      contextFrom(ATTEMPT, fromSql),
    );
    expect(contextFrom(ATTEMPT, fromFollows)).toEqual({
      kind: "ok",
      ctx: {
        worktreePath: "/wt/a",
        branchRef: attemptBranchRef(ATTEMPT),
        landed: {
          convIds: ["conv-a", "conv-b"],
          since: new Date(CREATED.getTime() - 60 * 60 * 1000),
        },
        ledgerPushes: 2,
      },
    });
  });

  test("a gone attempt is unmeasurable, whatever else was read", () => {
    const facts = attemptFactsFrom({
      attempt: [],
      convIds: [],
      pushIds: [],
      delivery: [],
    });
    expect(contextFrom(ATTEMPT, facts)).toEqual({
      kind: "unmeasurable",
      reason: "attempt no longer exists",
    });
  });

  test("a scratch attempt's standing is its delivery row", () => {
    const scratch = {
      ...followedAttempt,
      workspace: { kind: "scratch" as const },
      worktreePath: null,
    };
    const delivered = attemptFactsFrom({
      attempt: [scratch],
      convIds: [],
      pushIds: [],
      delivery: [{ attemptId: ATTEMPT }],
    });
    expect(contextFrom(ATTEMPT, delivered)).toEqual({
      kind: "no-git",
      delivered: true,
    });
    const none = attemptFactsFrom({
      attempt: [scratch],
      convIds: [],
      pushIds: [],
      delivery: [],
    });
    expect(contextFrom(ATTEMPT, none)).toEqual({
      kind: "no-git",
      delivered: false,
    });
  });
});
