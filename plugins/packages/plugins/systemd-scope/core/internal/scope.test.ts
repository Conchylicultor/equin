import { describe, expect, test } from "bun:test";
import {
  inOwnScope,
  OOMD_KILL_MESSAGE_ID,
  readScopeOomdKill,
  SCOPE_RECORD_WAIT_MS,
  scopeOomdKillFromJournal,
  userScopeHost,
  type ScopeCommandRunner,
} from "./scope";

const HOST = { kind: "systemd", runtimeDir: "/run/user/1000" } as const;
const UNIT = "build-1795052000-abcdef.scope";

/** One journal record as `journalctl -o json` prints it (fields abridged). */
const rec = (fields: Record<string, string>): string => JSON.stringify(fields);
// Real records of an oomd-killed scope, Ubuntu 24.04 / systemd 255 (2026-11-19).
const STARTED = rec({
  MESSAGE_ID: "39f53479d3a045ac8e11786248231fbf",
  MESSAGE: `Started ${UNIT}.`,
});
const OOMD_KILLED = rec({
  MESSAGE_ID: OOMD_KILL_MESSAGE_ID,
  MESSAGE: `${UNIT}: systemd-oomd killed 6 process(es) in this unit.`,
  N_PROCESSES: "6",
});
const CONSUMED = rec({
  MESSAGE_ID: "ae8f7b866b0347b9af31fe1c80b127c0",
  MESSAGE: `${UNIT}: Consumed 2min 16.102s CPU time.`,
});

describe("userScopeHost", () => {
  test("Linux with the user manager's socket can start scopes", () => {
    expect(
      userScopeHost({
        platform: "linux",
        uid: 1000,
        exists: (p) => p === "/run/user/1000/systemd/private",
      }),
    ).toEqual(HOST);
  });
  test("Linux without a user manager, and macOS, cannot", () => {
    expect(
      userScopeHost({ platform: "linux", uid: 1000, exists: () => false }).kind,
    ).toBe("none");
    expect(
      userScopeHost({ platform: "darwin", uid: 501, exists: () => true }).kind,
    ).toBe("none");
  });
});

describe("inOwnScope", () => {
  test("execs the command in a collected scope that survives a kernel kill of one process", () => {
    const scoped = inOwnScope(HOST, {
      argv: ["./equin", "build"],
      env: { PATH: "/usr/bin" },
      unit: UNIT,
      description: "equin build",
    });
    expect(scoped.unit).toBe(UNIT);
    expect(scoped.argv.slice(0, 4)).toEqual([
      "systemd-run",
      "--user",
      "--scope",
      "--quiet",
    ]);
    expect(scoped.argv).toContain("--collect");
    expect(scoped.argv).toContain(`--unit=${UNIT}`);
    expect(scoped.argv).toContain("--property=OOMPolicy=continue");
    // systemd-run finds the manager through XDG_RUNTIME_DIR; the command
    // itself gets the environment it was given.
    expect(scoped.env).toEqual({
      PATH: "/usr/bin",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
    expect(scoped.argv.slice(scoped.argv.indexOf("--") + 1)).toEqual([
      "env",
      "-u",
      "XDG_RUNTIME_DIR",
      "./equin",
      "build",
    ]);
  });
  test("a caller that already carries XDG_RUNTIME_DIR keeps it", () => {
    const scoped = inOwnScope(HOST, {
      argv: ["true"],
      env: { XDG_RUNTIME_DIR: "/run/user/1000" },
      unit: UNIT,
      description: "x",
    });
    expect(scoped.argv.slice(scoped.argv.indexOf("--") + 1)).toEqual(["true"]);
  });
  test("refuses a name that is not a scope unit", () => {
    expect(() =>
      inOwnScope(HOST, {
        argv: ["true"],
        env: {},
        unit: "build x.service",
        description: "x",
      }),
    ).toThrow("not a scope unit name");
  });
});

describe("scopeOomdKillFromJournal", () => {
  test("the manager's oomd-kill record", () => {
    expect(
      scopeOomdKillFromJournal([STARTED, OOMD_KILLED, CONSUMED].join("\n")),
    ).toEqual({ kind: "oomd-killed", processes: 6 });
  });
  test("a stop recorded with no oomd kill before it", () => {
    expect(scopeOomdKillFromJournal([STARTED, CONSUMED].join("\n"))).toEqual({
      kind: "not-oomd",
    });
  });
  test("neither yet: pending", () => {
    expect(scopeOomdKillFromJournal(STARTED + "\n")).toEqual({
      kind: "pending",
    });
    expect(scopeOomdKillFromJournal("")).toEqual({ kind: "pending" });
  });
});

describe("readScopeOomdKill", () => {
  /** A clock the reader's waits advance, and a journal that grows per read. */
  function journal(reads: string[]) {
    let t = 0;
    let n = 0;
    const run: ScopeCommandRunner = async (argv) => {
      expect(argv).toContain(`USER_UNIT=${UNIT}`);
      const out = reads[Math.min(n, reads.length - 1)] ?? "";
      n++;
      return { exitCode: 0, stdout: out, stderr: "" };
    };
    return {
      deps: {
        run,
        wait: async (ms: number) => {
          t += ms;
        },
        now: () => t,
      },
      reads: () => n,
    };
  }

  test("re-reads until the manager's records land", async () => {
    const j = journal([STARTED, STARTED, [STARTED, OOMD_KILLED].join("\n")]);
    expect(await readScopeOomdKill(HOST, UNIT, j.deps)).toEqual({
      kind: "oomd-killed",
      processes: 6,
    });
    expect(j.reads()).toBe(3);
  });

  test("gives up as unknown past the wait, never as not-oomd", async () => {
    const j = journal([STARTED]);
    const said = await readScopeOomdKill(HOST, UNIT, j.deps);
    expect(said.kind).toBe("unknown");
    expect(j.deps.now()).toBeGreaterThanOrEqual(SCOPE_RECORD_WAIT_MS);
  });

  test("an empty failing read is read again, then unknown with its reason", async () => {
    let t = 0;
    const said = await readScopeOomdKill(HOST, UNIT, {
      run: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "No journal files were opened",
      }),
      wait: async (ms) => {
        t += ms;
      },
      now: () => t,
    });
    expect(said.kind).toBe("unknown");
    expect(said.kind === "unknown" && said.why).toContain(
      "journalctl exited 1: No journal files were opened",
    );
  });

  test("a journalctl that cannot be spawned is unknown, not a throw", async () => {
    const said = await readScopeOomdKill(HOST, UNIT, {
      run: async () => {
        throw new Error("ENOENT: journalctl");
      },
      wait: async () => {},
      now: () => 0,
    });
    expect(said).toEqual({
      kind: "unknown",
      why: "journalctl could not run: ENOENT: journalctl",
    });
  });

  test("each read is bounded by what is left of the wait", async () => {
    const bounds: number[] = [];
    let t = 0;
    await readScopeOomdKill(HOST, UNIT, {
      run: async (_argv, _env, timeoutMs) => {
        bounds.push(timeoutMs);
        t += 4_000;
        return { exitCode: 0, stdout: STARTED, stderr: "" };
      },
      wait: async (ms) => {
        t += ms;
      },
      now: () => t,
    });
    expect(bounds[0]).toBe(SCOPE_RECORD_WAIT_MS);
    for (const b of bounds) expect(b).toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(SCOPE_RECORD_WAIT_MS + 4_000);
  });
});
