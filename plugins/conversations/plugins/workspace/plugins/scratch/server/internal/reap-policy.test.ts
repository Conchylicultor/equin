import { describe, expect, test } from "bun:test";
import { decideScratchReap, type ScratchDirFacts } from "./reap-policy";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 13);
const GRACE = 7 * DAY;
const ago = (days: number) => new Date(NOW - days * DAY);

function facts(attempt: ScratchDirFacts["attempt"], mtimeDaysAgo = 0) {
  return { attemptId: "att-1", mtimeMs: NOW - mtimeDaysAgo * DAY, attempt };
}

describe("decideScratchReap", () => {
  test("keeps a live attempt however old its dir", () => {
    const live = { retained: true, finishedAt: null, taskDroppedAt: null };
    expect(decideScratchReap(facts(live, 90), NOW, GRACE)).toEqual({
      reap: false,
    });
  });

  test("reaps a dropped task's dir only past the grace", () => {
    const dropped = (days: number) => ({
      retained: true,
      finishedAt: null,
      taskDroppedAt: ago(days),
    });
    expect(decideScratchReap(facts(dropped(3)), NOW, GRACE).reap).toBe(false);
    expect(decideScratchReap(facts(dropped(8)), NOW, GRACE).reap).toBe(true);
  });

  test("reaps a finished attempt's dir past the grace, never a retained one", () => {
    const finished = (retained: boolean) => ({
      retained,
      finishedAt: ago(10),
      taskDroppedAt: null,
    });
    expect(decideScratchReap(facts(finished(false)), NOW, GRACE).reap).toBe(
      true,
    );
    expect(decideScratchReap(facts(finished(true)), NOW, GRACE).reap).toBe(
      false,
    );
  });

  test("a dir with no attempt row is reaped only once untouched past the grace", () => {
    expect(decideScratchReap(facts(null, 2), NOW, GRACE).reap).toBe(false);
    expect(decideScratchReap(facts(null, 30), NOW, GRACE).reap).toBe(true);
  });
});
