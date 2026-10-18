/**
 * `standingOf`'s truth table — the one place a count is compared to zero, so this
 * is where the two defects the plugin exists for are pinned:
 *
 * - D1: an attempt whose work is already in `main` must NOT read as "none"
 *   (offering the destructive drop over landed work).
 * - D2: an attempt with committed-but-unpushed work must NOT read as "none".
 */
import { test, expect } from "bun:test";
import { standingOf } from "./standing";
import type { AttemptWork } from "./protocol";

function work(over: Partial<AttemptWork> = {}): AttemptWork {
  return {
    pending: {
      kind: "measured",
      ahead: 0,
      behind: 0,
      branch: "claude-web/att-1",
      mergeBase: "abc",
    },
    landedCommits: 0,
    landedPushes: 0,
    ledgerPushes: 0,
    delivered: false,
    ...over,
  };
}

test("ahead > 0 is pending, even alongside landed commits", () => {
  const w = work({
    pending: {
      kind: "measured",
      ahead: 2,
      behind: 0,
      branch: "b",
      mergeBase: "abc",
    },
    landedCommits: 5,
    landedPushes: 1,
    ledgerPushes: 1,
  });
  // Unpushed commits are the actionable state: this attempt still needs a push.
  expect(standingOf(w)).toBe("pending");
});

test("landed commits with nothing ahead is landed (D1)", () => {
  expect(standingOf(work({ landedCommits: 3, landedPushes: 1 }))).toBe(
    "landed",
  );
});

test("a ledger push alone is landed — the pre-trailer-era corroboration", () => {
  // Git found nothing (an old commit carries no Singularity-Conversation
  // trailer), but a push row PROVES a push happened. I3: ORed in, never used to
  // conclude the negative.
  expect(standingOf(work({ ledgerPushes: 2 }))).toBe("landed");
});

test("a deleted branch with nothing landed is none", () => {
  expect(standingOf(work({ pending: { kind: "no-branch" } }))).toBe("none");
});

test("a deleted branch still reads landed when git found commits", () => {
  expect(
    standingOf(
      work({
        pending: { kind: "no-branch" },
        landedCommits: 1,
        landedPushes: 1,
      }),
    ),
  ).toBe("landed");
});

test("all-zero measured is none — the drop affordance survives", () => {
  expect(standingOf(work())).toBe("none");
});

test("behind-only is none: main moving is not this attempt's work", () => {
  expect(
    standingOf(
      work({
        pending: {
          kind: "measured",
          ahead: 0,
          behind: 9,
          branch: "b",
          mergeBase: "abc",
        },
      }),
    ),
  ).toBe("none");
});

test("a scratch attempt's recorded delivery is landed; without one, none", () => {
  const scratch = { pending: { kind: "no-branch" } } as const;
  expect(standingOf(work({ ...scratch, delivered: true }))).toBe("landed");
  expect(standingOf(work(scratch))).toBe("none");
});
