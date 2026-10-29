import { describe, expect, test } from "bun:test";
import {
  AUTO_RESUME_MARGIN_MS,
  AUTO_RESUME_RETRY_MS,
  planAutoResume,
} from "./auto-resume";

const NOW = 1_800_000_000_000;

describe("planAutoResume", () => {
  test("nothing stopped: nothing to do, no next run", () => {
    expect(planAutoResume({ stopped: [], limit: null, now: NOW })).toEqual({
      resumeNow: [],
      nextAt: null,
    });
  });

  test("limit still reached: wait until it resets", () => {
    const resetsAt = NOW + 3_600_000;
    expect(
      planAutoResume({
        stopped: [{ id: "a", stoppedAt: NOW - 600_000 }],
        limit: { resetsAt },
        now: NOW,
      }),
    ).toEqual({ resumeNow: [], nextAt: resetsAt + AUTO_RESUME_MARGIN_MS });
  });

  test("room again: resumes every stop older than the retry wait", () => {
    expect(
      planAutoResume({
        stopped: [
          { id: "old", stoppedAt: NOW - AUTO_RESUME_RETRY_MS },
          { id: "older", stoppedAt: NOW - 3_600_000 },
        ],
        limit: null,
        now: NOW,
      }),
    ).toEqual({ resumeNow: ["old", "older"], nextAt: null });
  });

  test("a stop the reading has not caught: resumed after the retry wait", () => {
    expect(
      planAutoResume({
        stopped: [
          { id: "old", stoppedAt: NOW - 3_600_000 },
          { id: "fresh", stoppedAt: NOW - 1_000 },
          { id: "fresher", stoppedAt: NOW - 500 },
        ],
        limit: null,
        now: NOW,
      }),
    ).toEqual({
      resumeNow: ["old"],
      nextAt: NOW - 1_000 + AUTO_RESUME_RETRY_MS,
    });
  });
});
