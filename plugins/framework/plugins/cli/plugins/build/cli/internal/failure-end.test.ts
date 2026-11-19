import { describe, expect, test } from "bun:test";
import { buildStatusOf } from "@plugins/build/plugins/build-status/core";
import type { OomKillCount } from "@plugins/packages/plugins/host-memory/core";
import type { ScopeOomdKill } from "@plugins/packages/plugins/systemd-scope/core";
import { buildFailureEnd, deadBuildExitCode } from "./failure-end";

const FINISHED = new Date("2026-11-18T12:00:00Z");
const statusOf = (exitCode: number) =>
  buildStatusOf({ finishedAt: FINISHED, exitCode });

const count = (n: number): OomKillCount => ({ kind: "read", count: n });
/** The host counted no OOM kill while the build ran. */
const NO_OOM = { atStart: count(4), atEnd: count(4) };
/** The host counted two OOM kills while the build ran. */
const TWO_OOM = { atStart: count(4), atEnd: count(6) };

describe("buildFailureEnd", () => {
  test("a failure made only of killed children ends killed — no verdict in the ledger", () => {
    const end = buildFailureEnd({
      supersededBy: null,
      failures: [{ killedBy: "SIGKILL" }],
      oomKills: NO_OOM,
    });
    expect(end).toEqual({ kind: "killed", signal: "SIGKILL", exitCode: 137 });
    expect(statusOf(end.exitCode)).toBe("killed");
  });

  test("one failure that judged the code makes the build failed", () => {
    const end = buildFailureEnd({
      supersededBy: null,
      failures: [{ killedBy: "SIGKILL" }, { killedBy: null }],
      oomKills: TWO_OOM,
    });
    expect(end).toEqual({ kind: "failed", exitCode: 1 });
    expect(statusOf(end.exitCode)).toBe("failed");
  });

  test("a failure with no named cause is failed, never a kill", () => {
    expect(
      buildFailureEnd({ supersededBy: null, failures: [], oomKills: TWO_OOM })
        .kind,
    ).toBe("failed");
  });

  test("a superseded build stays superseded, kills or not", () => {
    const end = buildFailureEnd({
      supersededBy: "abc123",
      failures: [{ killedBy: "SIGKILL" }],
      oomKills: TWO_OOM,
    });
    expect(end.kind).toBe("superseded");
    expect(statusOf(end.exitCode)).toBe("superseded");
  });

  test("killed children while the host counted OOM kills end out-of-memory", () => {
    const end = buildFailureEnd({
      supersededBy: null,
      failures: [{ killedBy: "SIGKILL" }, { killedBy: "SIGTERM" }],
      oomKills: TWO_OOM,
    });
    expect(end).toEqual({ kind: "out-of-memory", oomKills: 2, exitCode: 71 });
    expect(statusOf(end.exitCode)).toBe("out-of-memory");
  });

  test("OOM kills on the host do not explain a kill that was not SIGKILL", () => {
    const end = buildFailureEnd({
      supersededBy: null,
      failures: [{ killedBy: "SIGTERM" }],
      oomKills: TWO_OOM,
    });
    expect(end).toEqual({ kind: "killed", signal: "SIGTERM", exitCode: 143 });
  });

  test("a counter that cannot be read never upgrades a kill — it stays killed", () => {
    const unknowns: OomKillCount[] = [
      { kind: "unsupported", platform: "darwin" },
      { kind: "unstated" },
      { kind: "unreadable", error: "EACCES" },
    ];
    for (const unknown of unknowns) {
      for (const oomKills of [
        { atStart: unknown, atEnd: count(6) },
        { atStart: count(4), atEnd: unknown },
      ]) {
        expect(
          buildFailureEnd({
            supersededBy: null,
            failures: [{ killedBy: "SIGKILL" }],
            oomKills,
          }).kind,
        ).toBe("killed");
      }
    }
  });

  test("a counter that went down (a reboot between readings) is not a kill seen", () => {
    expect(
      buildFailureEnd({
        supersededBy: null,
        failures: [{ killedBy: "SIGKILL" }],
        oomKills: { atStart: count(9), atEnd: count(1) },
      }).kind,
    ).toBe("killed");
  });
});

describe("deadBuildExitCode", () => {
  const SIGKILL_EXIT = 128 + 9;
  const NO_SCOPE: ScopeOomdKill = { kind: "unknown", why: "not in a scope" };
  const NOT_OOMD: ScopeOomdKill = { kind: "not-oomd" };
  const OOMD: ScopeOomdKill = { kind: "oomd-killed", processes: 6 };
  test("a build process SIGKILLed while the host counted an OOM kill ran out of memory", () => {
    const code = deadBuildExitCode(SIGKILL_EXIT, {
      oomKills: { atStart: count(4), atEnd: count(5) },
      scope: NOT_OOMD,
    });
    expect(statusOf(code)).toBe("out-of-memory");
  });
  test("a build systemd-oomd killed with its scope ran out of memory, though the kernel counted nothing", () => {
    const code = deadBuildExitCode(SIGKILL_EXIT, {
      oomKills: NO_OOM,
      scope: OOMD,
    });
    expect(statusOf(code)).toBe("out-of-memory");
  });
  test("a SIGKILL neither killer accounts for stays killed", () => {
    expect(
      deadBuildExitCode(SIGKILL_EXIT, { oomKills: NO_OOM, scope: NOT_OOMD }),
    ).toBe(SIGKILL_EXIT);
    expect(
      deadBuildExitCode(SIGKILL_EXIT, { oomKills: NO_OOM, scope: NO_SCOPE }),
    ).toBe(SIGKILL_EXIT);
  });
  test("an unknown counter never upgrades a kill", () => {
    expect(
      deadBuildExitCode(SIGKILL_EXIT, {
        oomKills: {
          atStart: { kind: "unsupported", platform: "darwin" },
          atEnd: { kind: "unsupported", platform: "darwin" },
        },
        scope: NO_SCOPE,
      }),
    ).toBe(SIGKILL_EXIT);
  });
  test("any other end is the build's own record, unchanged", () => {
    for (const code of [0, 1, 71, 75, 128 + 15]) {
      expect(
        deadBuildExitCode(code, {
          oomKills: { atStart: count(1), atEnd: count(9) },
          scope: OOMD,
        }),
      ).toBe(code);
    }
  });
});
