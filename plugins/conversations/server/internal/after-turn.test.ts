import { describe, expect, test } from "bun:test";
import type { JobCtx } from "@plugins/infra/plugins/jobs/server";
import { turnIsOver, waitAfterTurn, type TurnStateRow } from "./after-turn";

const SUSPEND = Symbol("suspend");

/**
 * The durable wait's contract in miniature: the trigger is armed, then
 * `settled.recheck` runs — `true` resolves the wait at once with `null`,
 * `false` suspends (the job returns until the event wakes it).
 */
function fakeCtx(): {
  ctx: Pick<JobCtx, "waitFor">;
  armed: () => number;
} {
  let armed = 0;
  const ctx: Pick<JobCtx, "waitFor"> = {
    waitFor: (async (_event: unknown, opts: { settled: unknown }) => {
      armed++;
      const settled = opts.settled as
        { recheck: () => Promise<boolean> } | { noRecheck: string };
      if (!("recheck" in settled)) throw SUSPEND;
      if (await settled.recheck()) return null;
      throw SUSPEND;
    }) as JobCtx["waitFor"],
  };
  return { ctx, armed: () => armed };
}

const row = (over: Partial<TurnStateRow>): TurnStateRow => ({
  status: "working",
  workingOn: "turn",
  statusUnverifiedSince: null,
  ...over,
});

describe("afterTurn", () => {
  test("a turn that ended before the wait was armed resolves it at once", async () => {
    const { ctx, armed } = fakeCtx();
    const result = await waitAfterTurn(
      ctx,
      "conv-1",
      { timeoutMs: 60_000 },
      () => Promise.resolve(row({ status: "waiting", workingOn: null })),
    );
    expect(result).toBeNull();
    expect(armed()).toBe(1);
  });

  test("a turn still running suspends on the event", () => {
    const { ctx } = fakeCtx();
    expect(
      waitAfterTurn(ctx, "conv-1", { timeoutMs: 60_000 }, () =>
        Promise.resolve(row({})),
      ),
    ).rejects.toBe(SUSPEND);
  });
});

describe("turnIsOver", () => {
  test("a running turn is not over", () => {
    expect(turnIsOver(row({}))).toBe(false);
  });
  test("an agent at rest, or only running background work, has ended its turn", () => {
    expect(turnIsOver(row({ status: "waiting", workingOn: null }))).toBe(true);
    expect(turnIsOver(row({ workingOn: "background" }))).toBe(true);
  });
  test("an agent gone or closed, or a missing row, has no turn left", () => {
    expect(turnIsOver(row({ status: "gone", workingOn: null }))).toBe(true);
    expect(turnIsOver(row({ status: "done", workingOn: null }))).toBe(true);
    expect(turnIsOver(null)).toBe(true);
  });
  test("a starting agent or an unverified status is left to the event", () => {
    expect(turnIsOver(row({ status: "starting", workingOn: null }))).toBe(
      false,
    );
    expect(
      turnIsOver(
        row({
          status: "waiting",
          workingOn: null,
          statusUnverifiedSince: new Date(),
        }),
      ),
    ).toBe(false);
  });
});
