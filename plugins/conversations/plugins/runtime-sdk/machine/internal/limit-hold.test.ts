import { describe, expect, test } from "bun:test";
import {
  ClaudeCliError,
  ClaudeUsageLimitError,
} from "@plugins/infra/plugins/claude-cli/server";
import { AUTO_RESUME_MARGIN_MS, type ClaudeUsageRefresh } from "../../core";
import {
  holdAtLimit,
  UnplacedClaudeLimitError,
  type LimitReader,
} from "./limit-hold";

// A stand-in for the durable sleep: records how long, then suspends the run
// the way the real one does (by throwing), so the test sees what a job would.
class Suspended extends Error {}
function sleeper() {
  const slept: number[] = [];
  return {
    slept,
    ctx: {
      sleep: (ms: number): Promise<void> => {
        slept.push(ms);
        throw new Suspended();
      },
    },
  };
}

const HOUR = 3_600_000;
const limitHit = () =>
  new ClaudeUsageLimitError("You've hit your weekly limit", "acct");
const fullWeek = (resetsAt: number): ClaudeUsageRefresh => ({
  kind: "read",
  usage: {
    observedAt: Date.now(),
    session: null,
    week: { utilization: 1, resetsAt },
  },
});

function reader(over: Partial<LimitReader> = {}): LimitReader {
  return {
    known: () => Promise.resolve(null),
    readNow: () => Promise.reject(new Error("readNow not expected")),
    ...over,
  };
}

describe("holdAtLimit", () => {
  test("no limit known: the call runs and its answer is returned", async () => {
    const { ctx, slept } = sleeper();
    expect(
      await holdAtLimit(ctx, () => Promise.resolve("title"), reader()),
    ).toBe("title");
    expect(slept).toEqual([]);
  });

  test("a known limit sleeps until its reset without calling", async () => {
    const resetsAt = Date.now() + HOUR;
    const { ctx, slept } = sleeper();
    let calls = 0;
    const run = holdAtLimit(
      ctx,
      () => {
        calls++;
        return Promise.resolve("x");
      },
      reader({ known: () => Promise.resolve({ resetsAt }) }),
    );
    expect(await run.catch((e: unknown) => e)).toBeInstanceOf(Suspended);
    expect(calls).toBe(0);
    expect(slept).toHaveLength(1);
    const ms = slept[0] ?? 0;
    expect(ms).toBeGreaterThan(HOUR + AUTO_RESUME_MARGIN_MS - 1000);
    expect(ms).toBeLessThanOrEqual(HOUR + AUTO_RESUME_MARGIN_MS);
  });

  test("a limit the call hits is read and slept out", async () => {
    const resetsAt = Date.now() + 2 * HOUR;
    const { ctx, slept } = sleeper();
    const run = holdAtLimit(
      ctx,
      () => Promise.reject(limitHit()),
      reader({ readNow: () => Promise.resolve(fullWeek(resetsAt)) }),
    );
    expect(await run.catch((e: unknown) => e)).toBeInstanceOf(Suspended);
    expect(slept).toHaveLength(1);
  });

  test("a limit no reading confirms fails loudly, not as a ClaudeCliError", async () => {
    const { ctx, slept } = sleeper();
    const run = holdAtLimit(
      ctx,
      () => Promise.reject(limitHit()),
      reader({
        readNow: () =>
          Promise.resolve({ kind: "unavailable", reason: "an API key" }),
      }),
    );
    expect(run).rejects.toBeInstanceOf(UnplacedClaudeLimitError);
    const err = await run.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ClaudeCliError);
    expect(slept).toEqual([]);
  });

  test("any other failure is thrown as it came", async () => {
    const { ctx } = sleeper();
    const boom = new ClaudeCliError("Claude Code did not finish");
    const run = holdAtLimit(ctx, () => Promise.reject(boom), reader());
    expect(run).rejects.toBe(boom);
  });
});
