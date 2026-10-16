/**
 * Tests for the wedge-proof capture spawn. Run with `bun test`.
 *
 * The FIRST test is the load-bearing gate for the whole plan: it proves that
 * numeric temp-file fds work as `Bun.spawn` stdio targets on this machine's
 * bun (verified on 1.3.13). If that test fails, the fd mechanics regressed —
 * fall back to `Bun.file(path)` targets before touching anything else.
 *
 * The stress test at the end is the wedge smoke test: a burst of fast-exiting
 * noisy children is exactly the shape that wedges piped stdio (child exits
 * during a pending stream pull); with fd redirection it must always complete.
 */

import { test, expect } from "bun:test";
import { getEventListeners } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  spawnCaptured,
  spawnExpectOk,
  SpawnFailedError,
} from "./internal/spawn-captured";
import { spawnPassthrough } from "./internal/spawn-passthrough";

/**
 * The bound every test here that is NOT about bounds uses. These children are
 * `echo` / `cat` / a one-line node script, so ten seconds is unreachable except
 * by the wedge the whole plugin exists to prevent — which makes it the right
 * failure for this suite: a wedged child fails one named test instead of hanging
 * the runner with nothing to read.
 *
 * Spread it (`{ ...BOUND, cwd }`) rather than restating a number per call, so
 * the suite has one place to change if the box it runs on ever needs more.
 */
const BOUND = { timeoutMs: 10_000 } as const;

/**
 * Await a promise that MUST reject, and hand back what it threw.
 *
 * Used instead of `await expect(p).rejects.…`: bun:test types that matcher as
 * returning `void`, so awaiting it is an `await-thenable` lint error, and the
 * un-awaited form would let a rejection escape the test as an unhandled one.
 * Returning the reason also lets each caller assert on identity — these tests
 * care that `signal.reason` arrives verbatim, not merely that something threw.
 */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

test("GATE: numeric-fd stdio — echo roundtrip captures stdout", async () => {
  const result = await spawnCaptured(["echo", "hello-fd"], BOUND);
  expect(result.exitCode).toBe(0);
  expect(result.signalCode).toBeNull();
  expect(result.stdout).toBe("hello-fd\n");
  expect(result.stderr).toBe("");
});

test("non-zero exit is a result, not an error", async () => {
  const result = await spawnCaptured(
    ["sh", "-c", "echo failing 1>&2; exit 3"],
    BOUND,
  );
  expect(result.exitCode).toBe(3);
  expect(result.stderr).toBe("failing\n");
  expect(result.stdout).toBe("");
});

test("spawnExpectOk throws SpawnFailedError carrying the capture", async () => {
  expect.assertions(4);
  try {
    await spawnExpectOk(["sh", "-c", "echo diagnostics 1>&2; exit 7"], BOUND);
  } catch (err) {
    if (!(err instanceof SpawnFailedError)) throw err;
    expect(err.exitCode).toBe(7);
    expect(err.stderr).toBe("diagnostics\n");
    expect(err.argv[0]).toBe("sh");
    expect(err.message).toContain("exit 7");
  }
});

test("binary fidelity: stdoutBytes carries all 256 byte values untouched", async () => {
  const script =
    "process.stdout.write(Buffer.from(Array.from({ length: 256 }, (_, i) => i)));";
  const result = await spawnCaptured([process.execPath, "-e", script], BOUND);
  expect(result.exitCode).toBe(0);
  expect(result.stdoutBytes.length).toBe(256);
  for (let i = 0; i < 256; i++) expect(result.stdoutBytes[i]).toBe(i);
});

test("stdin roundtrip: whole-buffer string in, cat out, EOF terminates", async () => {
  const result = await spawnCaptured(["cat"], {
    ...BOUND,
    stdin: "line-1\nline-2\n",
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("line-1\nline-2\n");
});

test("stdin roundtrip: Uint8Array in", async () => {
  const bytes = new Uint8Array([0x61, 0x0a, 0x62]);
  const result = await spawnCaptured(["cat"], { ...BOUND, stdin: bytes });
  expect(result.exitCode).toBe(0);
  expect(result.stdoutBytes).toEqual(bytes);
});

test("mergeStderr interleaves 2>&1 into stdout; stderr is empty", async () => {
  const result = await spawnCaptured(["sh", "-c", "echo out; echo err 1>&2"], {
    ...BOUND,
    mergeStderr: true,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("out\nerr\n");
  expect(result.stderr).toBe("");
  expect(result.stderrBytes.length).toBe(0);
});

test("cwd is honored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-spawn-cwd-"));
  try {
    const result = await spawnCaptured(["sh", "-c", "pwd"], {
      ...BOUND,
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
    expect(realpathSync(result.stdout.trim())).toBe(realpathSync(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("env is a full replacement, same contract as Bun.spawn", async () => {
  const result = await spawnCaptured(
    ["sh", "-c", 'printf %s "$SG_SPAWN_TEST"'],
    {
      ...BOUND,
      env: { ...process.env, SG_SPAWN_TEST: "visible" },
    },
  );
  expect(result.stdout).toBe("visible");
});

test("every child runs with git's optional locks off, whatever env the caller passes", async () => {
  const probe = ["sh", "-c", 'printf %s "$GIT_OPTIONAL_LOCKS"'];
  expect((await spawnCaptured(probe, BOUND)).stdout).toBe("0");
  expect(
    (await spawnCaptured(probe, { ...BOUND, env: { PATH: process.env.PATH } }))
      .stdout,
  ).toBe("0");
  expect(
    (await spawnPassthrough(["sh", "-c", 'test "$GIT_OPTIONAL_LOCKS" = 0']))
      .exitCode,
  ).toBe(0);
});

test("a git status run through the primitive never rewrites the index", async () => {
  // Plain `git status` on a file whose stat changed rewrites .git/index (taking
  // index.lock) — the write that broke concurrent pushes into main.
  const dir = mkdtempSync(join(tmpdir(), "sg-spawn-git-"));
  try {
    const git = (...args: string[]) =>
      spawnExpectOk(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args],
        { ...BOUND, cwd: dir },
      );
    await git("init", "-q");
    writeFileSync(join(dir, "f"), "a");
    await git("add", "f");
    await git("commit", "-qm", "x");
    const index = join(dir, ".git", "index");
    const before = readFileSync(index);
    // Same content, new stat: the index's cached stat is now stale.
    utimesSync(join(dir, "f"), new Date(0), new Date(0));
    await git("status", "--porcelain");
    expect(readFileSync(index).equals(before)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resourceUsage reports the child's peak RSS", async () => {
  const result = await spawnCaptured(["echo", "rss"], BOUND);
  expect(result.exitCode).toBe(0);
  // Bun reports rusage on darwin/linux; a positive byte count for any real child.
  expect(result.resourceUsage.maxRssBytes).toBeGreaterThan(0);
});

test("resourceUsage reports the child's CPU time in microseconds", async () => {
  // A child that burns a measurable slice of CPU, so the assertion is about the
  // unit rather than about rounding: ~0.2s of shell loop is >10_000 µs and, on
  // any machine, far under the 1e9 µs (~17 min) an accidental nanosecond or
  // millisecond scaling would have to produce.
  const result = await spawnCaptured(
    ["bash", "-c", "for i in $(seq 1 200000); do :; done"],
    BOUND,
  );
  expect(result.exitCode).toBe(0);
  expect(result.resourceUsage.cpuTimeMicros).toBeGreaterThan(10_000);
  expect(result.resourceUsage.cpuTimeMicros).toBeLessThan(1e9);
});

test("no timeoutMs: timedOut is false and nothing is killed", async () => {
  // The one place `unbounded` is the RIGHT arm rather than a fallback: this test
  // exists to assert what the unbounded arm does, so writing it any other way
  // would test something else.
  const result = await spawnCaptured(["echo", "unbounded"], {
    unbounded: "this test's subject is the no-deadline path itself",
  });
  expect(result.timedOut).toBe(false);
  expect(result.signalCode).toBeNull();
});

test("timeoutMs kills a hung child and reports timedOut", async () => {
  const started = Date.now();
  const result = await spawnCaptured(["sleep", "30"], { timeoutMs: 250 });
  // The deadline is what returned us — not `sleep` finishing 30s later.
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(result.timedOut).toBe(true);
  expect(result.signalCode).toBe("SIGTERM");
}, 15_000);

test("timeoutMs that does not expire leaves the result untouched", async () => {
  const result = await spawnCaptured(["echo", "in-time"], {
    timeoutMs: 30_000,
  });
  expect(result.exitCode).toBe(0);
  expect(result.timedOut).toBe(false);
  expect(result.stdout).toBe("in-time\n");
});

test("output written before the deadline is still captured", async () => {
  const result = await spawnCaptured(["sh", "-c", "echo early; sleep 30"], {
    timeoutMs: 400,
  });
  expect(result.timedOut).toBe(true);
  expect(result.stdout).toBe("early\n");
}, 15_000);

// --- signal: ambient cancellation. Unlike `timeoutMs` these THROW, so an
// abandoned caller cannot read the cancellation as a value and keep going.

test("an already-aborted signal spawns no child at all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-spawn-abort-"));
  try {
    const marker = join(dir, "ran");
    const controller = new AbortController();
    controller.abort();
    expect(
      await rejection(
        spawnCaptured(["touch", marker], { signal: controller.signal }),
      ),
    ).toBeInstanceOf(Error);
    // The proof is the absence of the side effect: we returned before Bun.spawn.
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aborting mid-flight kills the child and rejects with signal.reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-spawn-abort-"));
  try {
    const pidFile = join(dir, "pid");
    const controller = new AbortController();
    const reason = new Error("caller was abandoned");
    const started = Date.now();
    // `exec` keeps the pid: what we record is the process we later assert is gone.
    const promise = spawnCaptured(
      ["sh", "-c", `echo $$ > ${pidFile}; exec sleep 30`],
      {
        signal: controller.signal,
      },
    );
    await Bun.sleep(150);
    controller.abort(reason);
    expect(await rejection(promise)).toBe(reason);
    // Returned on the kill, not on `sleep 30` finishing, and inside the grace.
    expect(Date.now() - started).toBeLessThan(5_000);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

test("an abort still throws even when the child exited cleanly first", async () => {
  const controller = new AbortController();
  // Ignores TERM, so it survives the escalation and exits 0 with real output
  // AFTER the abort. The good result is discarded on purpose: the caller was
  // told to stop before it was ever handed the value.
  const promise = spawnCaptured(
    ["sh", "-c", 'trap "" TERM; sleep 0.5; echo done'],
    {
      signal: controller.signal,
    },
  );
  await Bun.sleep(100);
  controller.abort();
  expect(String(await rejection(promise))).toMatch(/aborted/i);
}, 15_000);

test("abort wins over timedOut when the deadline fired first", async () => {
  const controller = new AbortController();
  const reason = new Error("abandoned after the deadline");
  // TERM-proof: the 100ms deadline fires (timedOut := true) but cannot end the
  // child, so the abort lands while a timed-out result is already pending. The
  // SIGKILL that finally reaps it is the deadline's own escalation timer — the
  // abort must not have scheduled a second one.
  const promise = spawnCaptured(["sh", "-c", 'trap "" TERM; sleep 30'], {
    timeoutMs: 100,
    signal: controller.signal,
  });
  await Bun.sleep(300);
  controller.abort(reason);
  expect(await rejection(promise)).toBe(reason);
}, 15_000);

test("many spawns on one long-lived signal leave no listeners behind", async () => {
  const controller = new AbortController();
  const warnings: string[] = [];
  const onWarning = (w: Error) => warnings.push(w.name);
  process.on("warning", onWarning);
  try {
    // Sequential and well past any listener cap: a leak of one listener per call
    // is what would trip MaxListenersExceededWarning on a batch caller's
    // dispatch-lifetime signal.
    for (let i = 0; i < 60; i++) {
      const result = await spawnCaptured(["echo", "ok"], {
        signal: controller.signal,
      });
      expect(result.exitCode).toBe(0);
    }
    expect(getEventListeners(controller.signal, "abort").length).toBe(0);
    expect(warnings).not.toContain("MaxListenersExceededWarning");
  } finally {
    process.off("warning", onWarning);
  }
}, 60_000);

test("spawnExpectOk propagates the abort reason, not SpawnFailedError", async () => {
  const controller = new AbortController();
  const reason = new Error("stop");
  const promise = spawnExpectOk(["sh", "-c", "sleep 30; exit 3"], {
    signal: controller.signal,
  });
  await Bun.sleep(100);
  controller.abort(reason);
  expect(await rejection(promise)).toBe(reason);
}, 15_000);

test('tier: "background" demotes without breaking the capture', async () => {
  const result = await spawnCaptured(["echo", "demoted"], {
    ...BOUND,
    tier: "background",
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("demoted\n");
});

test("wedge smoke: 200 fast-exiting noisy children complete (concurrency 20)", async () => {
  const total = 200;
  const concurrency = 20;
  let next = 0;
  const runOne = async () => {
    const result = await spawnCaptured(
      ["sh", "-c", "echo out; echo err 1>&2"],
      BOUND,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("err\n");
  };
  const workers = Array.from({ length: concurrency }, async () => {
    while (next < total) {
      next++;
      await runOne();
    }
  });
  await Promise.all(workers);
}, 60_000);

test("a child that survives the deadline and succeeds is not reported as timed out", async () => {
  // REGRESSION (2026-08-17). `timedOut` must mean "we killed a child that was
  // still running", never "our deadline elapsed without us observing an exit" —
  // the two come apart because `child.exitCode` is only populated at reap time,
  // and reaping needs the event loop the parent may be blocking. In the field,
  // `./singularity check` blocks its own loop ~77s building TypeScript programs,
  // and a `git worktree list` that finished in 73ms came back
  // `timedOut: true, exitCode: 0` — a successful result discarded as a timeout,
  // which made `worktreeListPaths` throw and killed the CLI at boot.
  //
  // Reproduced deterministically instead of by starvation: the child ignores
  // SIGTERM, so the deadline provably fires against a live child (`timedOut` is
  // set and the kill is delivered) and yet the child goes on to exit 0 on its
  // own, well before the SIGKILL grace elapses. Only an OUTCOME-based decision
  // gets this right; a timer-based one reports the timeout it intended.
  const result = await spawnCaptured(
    ["sh", "-c", 'trap "" TERM; sleep 1; echo survived; exit 0'],
    { timeoutMs: 300 },
  );
  expect(result.exitCode).toBe(0);
  expect(result.signalCode).toBeNull();
  expect(result.stdout).toBe("survived\n");
  expect(result.timedOut).toBe(false);
}, 20_000);
