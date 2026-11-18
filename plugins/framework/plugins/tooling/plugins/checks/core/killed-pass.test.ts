import { describe, expect, test } from "bun:test";
import { ChildKilledError } from "@plugins/infra/plugins/spawn/core";
import { passKilledBy, withKillsSeen } from "./killed-pass";

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

describe("withKillsSeen", () => {
  const kill = (signal: string) =>
    new ChildKilledError("`git ls-files`", signal);

  test("a failure that saw a killed child is no verdict: killedBy, the kill named", () => {
    const r = withKillsSeen(fail(), [kill("SIGKILL"), kill("SIGTERM")]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.killedBy).toBe("SIGKILL");
    expect(r.message).toContain("`git ls-files` was killed by SIGKILL");
    expect(passKilledBy([r])).toBe("SIGKILL");
  });

  test("no kill, a pass, an inconclusive or an already-typed kill is left as it is", () => {
    expect(withKillsSeen(fail(), [])).toEqual(fail());
    expect(withKillsSeen({ ok: true }, [kill("SIGKILL")])).toEqual({
      ok: true,
    });
    const inconclusive = { ...fail(), inconclusive: true as const };
    expect(withKillsSeen(inconclusive, [kill("SIGKILL")])).toEqual(
      inconclusive,
    );
    expect(withKillsSeen(fail("SIGSEGV"), [kill("SIGKILL")])).toEqual(
      fail("SIGSEGV"),
    );
  });
});
