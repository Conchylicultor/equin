import { describe, expect, test } from "bun:test";
import { passKilledBy } from "./killed-pass";

const fail = (killedBy?: string) => ({
  ok: false as const,
  message: "m",
  ...(killedBy === undefined ? {} : { killedBy }),
});

describe("passKilledBy", () => {
  test("every failure a kill: the pass is killed, named by the first signal", () => {
    expect(passKilledBy([fail("SIGKILL")])).toBe("SIGKILL");
    expect(passKilledBy([fail("SIGKILL"), fail("SIGSEGV")])).toBe("SIGKILL");
  });

  test("one real failure makes it a verdict", () => {
    expect(passKilledBy([fail("SIGKILL"), fail()])).toBeNull();
  });

  test("nothing failed is not killed", () => {
    expect(passKilledBy([])).toBeNull();
  });

  test("an inconclusive check neither makes nor breaks it", () => {
    expect(
      passKilledBy([fail("SIGKILL"), { ...fail(), inconclusive: true }]),
    ).toBe("SIGKILL");
    expect(passKilledBy([{ ...fail(), inconclusive: true }])).toBeNull();
  });
});
