import { describe, expect, test } from "bun:test";
import {
  ARM_TRAVEL,
  MAX_TRAVEL,
  createPullRefresh,
  pullTravel,
  type PullRefreshHost,
} from "./pull-refresh";

function fakeHost() {
  const log: string[] = [];
  const host: PullRefreshHost = {
    setShown: (shown) => log.push(shown ? "show" : "hide"),
    disc: () => null,
    refresh: () => log.push("refresh"),
  };
  return { host, log };
}

describe("pullTravel", () => {
  test("is 0 at rest and never past the max", () => {
    expect(pullTravel(0)).toBe(0);
    expect(pullTravel(-50)).toBe(0);
    expect(pullTravel(10_000)).toBeLessThanOrEqual(MAX_TRAVEL);
  });
  test("grows with the pull and arms within a comfortable thumb reach", () => {
    expect(pullTravel(40)).toBeLessThan(pullTravel(80));
    expect(pullTravel(200)).toBeGreaterThanOrEqual(ARM_TRAVEL);
    expect(pullTravel(100)).toBeLessThan(ARM_TRAVEL);
  });
});

describe("createPullRefresh", () => {
  test("letting go past the arm point refreshes", () => {
    const { host, log } = fakeHost();
    const r = createPullRefresh(host);
    r.pull(120);
    r.pull(120);
    expect(r.active).toBe(true);
    r.release(true);
    expect(r.active).toBe(false);
    expect(log).toEqual(["show", "refresh"]);
  });
  test("a short pull, a pull pushed back up, or a cancelled touch does not", () => {
    for (const run of [
      (r: ReturnType<typeof createPullRefresh>) => {
        r.pull(30);
        r.release(true);
      },
      (r: ReturnType<typeof createPullRefresh>) => {
        r.pull(300);
        r.pull(-290);
        r.release(true);
      },
      (r: ReturnType<typeof createPullRefresh>) => {
        r.pull(300);
        r.release(false);
      },
    ]) {
      const { host, log } = fakeHost();
      const r = createPullRefresh(host);
      run(r);
      r.dispose();
      expect(log).not.toContain("refresh");
    }
  });
});
