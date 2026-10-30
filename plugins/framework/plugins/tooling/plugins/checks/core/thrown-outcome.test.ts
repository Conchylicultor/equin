import { describe, expect, test } from "bun:test";
import {
  InconclusiveCheckError,
  type Check,
} from "@plugins/framework/plugins/tooling/core";
import { thrownOutcome, type CheckObservation } from "./thrown-outcome";

// Pure: no check registry, no runner. A check that throws must fail ITSELF —
// named, fatal, uncached, stack kept — so that shape is pinned here rather
// than inferred from a full run.
const check: Check = {
  id: "some:check",
  description: "a check that throws",
  run: () => Promise.reject(new Error("unused")),
};

function settle(err: unknown, observations: CheckObservation[] = []) {
  return thrownOutcome(check, err, {
    wallStart: 10,
    durationMs: 42,
    observations,
  });
}

function failed(outcome: ReturnType<typeof settle>) {
  if (outcome.result.ok) throw new Error("expected a failed result");
  return outcome.result;
}

describe("thrownOutcome", () => {
  test("a thrown Error is a fatal, uncached FAIL carrying its stack", () => {
    const err = new Error("Connection terminated due to connection timeout");
    const observations: CheckObservation[] = [
      { line: "forking schema…", stream: "stdout" },
    ];
    const outcome = settle(err, observations);
    const result = failed(outcome);

    expect(outcome.check).toBe(check);
    expect(outcome.cached).toBe(false);
    expect(outcome.durationMs).toBe(42);
    expect(outcome.wallStart).toBe(10);
    // Lines the check logged before throwing survive.
    expect(outcome.observations).toEqual(observations);

    expect(result.inconclusive).toBeUndefined();
    expect(result.message).toStartWith(
      "threw instead of returning a result:\n",
    );
    expect(result.message).toContain(err.stack ?? "no stack");
    expect(result.hint).toContain("bug in the check");
    expect(result.hint).toContain("still ran");
  });

  test("an InconclusiveCheckError settles as a non-fatal inconclusive", () => {
    const err = new InconclusiveCheckError(
      "`git cat-file --batch` timed out after 120s",
      "re-run on a quieter host",
    );
    const outcome = settle(err);
    const result = failed(outcome);
    expect(outcome.cached).toBe(false);
    expect(result.inconclusive).toBe(true);
    expect(result.message).toBe("`git cat-file --batch` timed out after 120s");
    expect(result.hint).toBe("re-run on a quieter host");
  });

  test("an Error's cause chain is kept", () => {
    const err = new Error("outer", { cause: new Error("inner") });
    expect(failed(settle(err)).message).toContain("cause: Error: inner");
  });

  test("a thrown string is used as-is", () => {
    expect(failed(settle("boom")).message).toBe(
      "threw instead of returning a result:\nboom",
    );
  });

  test("a thrown object is stringified, not rendered as [object Object]", () => {
    const message = failed(settle({ code: "ETIMEDOUT", attempt: 2 })).message;
    expect(message).toContain("ETIMEDOUT");
    expect(message).toContain("attempt");
    expect(message).not.toContain("[object Object]");
  });

  test("a circular thrown object does not throw while being stringified", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(failed(settle(cyclic)).message).toContain("loop");
  });
});
