/**
 * The tap can only be observed from outside the process that installs it, so
 * every case here drives `signal-origin.fixture.ts` as a real child and reads
 * back what it recorded. See that file for the on-disk protocol.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ensureDep } from "@plugins/infra/plugins/deps/deps";
import { execContextForTests } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core/testing";
import type { SignalOrigin } from "../../core";
import { signalOriginShim } from "../../deps";
import type { SignalOriginArmResult } from "./signal-origin";

const FIXTURE = join(import.meta.dir, "signal-origin.fixture.ts");
const READY_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 20_000;

// The fixture arms from the real `signal-origin-shim` install (it takes it
// with `readyNow`), so the suite ensures it first — a real compile the first
// time on this machine, the fast path after.
beforeAll(async () => {
  await ensureDep(signalOriginShim, execContextForTests());
}, 120_000);

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "signal-origin-"));
  scratchDirs.push(dir);
  return dir;
}

/** The fixture writes `ready` last, so its appearance means "armed — safe to signal". */
async function awaitReady(dir: string, proc: Bun.Subprocess): Promise<number> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const readyPath = join(dir, "ready");
  while (Date.now() < deadline) {
    if (existsSync(readyPath)) return Number(readFileSync(readyPath, "utf8"));
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(
        `fixture exited before arming (code=${proc.exitCode} signal=${proc.signalCode})`,
      );
    }
    await Bun.sleep(20);
  }
  throw new Error("fixture never became ready");
}

async function awaitExit(proc: Bun.Subprocess): Promise<void> {
  const timer = setTimeout(() => proc.kill("SIGKILL"), EXIT_TIMEOUT_MS);
  await proc.exited;
  clearTimeout(timer);
}

/**
 * stdout is discarded rather than piped: the child is about to be killed, and
 * holding a pipe across that is exactly the bun exit-during-stream-pull wedge.
 * stderr is inherited so a fixture crash is visible in the test output.
 */
function spawnFixture(
  mode: string,
  dir: string,
  env?: Record<string, string>,
): Bun.Subprocess {
  return Bun.spawn(["bun", FIXTURE, "--mode", mode, "--out", dir], {
    stdout: "ignore",
    stderr: "inherit",
    env: { ...process.env, ...env },
  });
}

function readJson<T>(dir: string, name: string): T {
  return JSON.parse(readFileSync(join(dir, name), "utf8")) as T;
}

/**
 * A sender that OUTLIVES the signal: the shell sends via its own builtin (so the
 * shell's pid is `si_pid`) and then sleeps.
 *
 * The obvious `sh -c 'exec /bin/kill -TERM <pid>'` is deliberately not used for
 * the identity assertions — see the "reaped sender" test for why it is racy by
 * nature rather than by defect. The caller must kill the returned process.
 */
function killFromLivingSender(targetPid: number): Bun.Subprocess {
  return Bun.spawn(["/bin/sh", "-c", `kill -TERM ${targetPid}; sleep 30`], {
    stdout: "ignore",
    stderr: "inherit",
  });
}

/** `exec` means the shell IS the `kill` — a sender that exits the instant it has signalled. */
function killFromShortLivedBinary(targetPid: number): Bun.Subprocess {
  return Bun.spawn(["/bin/sh", "-c", `exec /bin/kill -TERM ${targetPid}`], {
    stdout: "ignore",
    stderr: "inherit",
  });
}

describe("armSignalOrigin / readSignalOrigin", () => {
  test("records the pid, path and ancestry of the process that sent the signal", async () => {
    const dir = scratch();
    const proc = spawnFixture("listener", dir);
    const victimPid = await awaitReady(dir, proc);

    const arm = readJson<SignalOriginArmResult>(dir, "arm.json");
    if (!arm.armed) throw new Error(`tap did not arm: ${arm.reason}`);

    const killer = killFromLivingSender(victimPid);
    const killerPid = killer.pid;
    await awaitExit(proc);
    killer.kill("SIGKILL");

    const origin = readJson<SignalOrigin | null>(dir, "origin.json");
    expect(origin).not.toBeNull();
    // The whole point: `process.on("SIGTERM")` alone knows none of this.
    expect(origin?.senderPid).toBe(killerPid);
    expect(origin?.signal).toBe(15);
    expect(origin?.hits).toBe(1);
    expect(origin?.ancestryErrno).toBe(0);
    // ancestry[0] IS the sender...
    expect(origin?.ancestry[0]?.pid).toBe(killerPid);
    // ...and its parent is this test process, which spawned the shell — the
    // chain the handler walked, not something reconstructed afterwards.
    expect(origin?.ancestry[1]?.pid).toBe(process.pid);
    // `comm` is the basename of the resolved executable. Asserted structurally
    // rather than as a literal: /bin/sh is bash on darwin and dash on most
    // linuxes, and the identity is the pid, not the name.
    expect(origin?.senderPath).not.toBeNull();
    expect(origin?.ancestry[0]?.comm).toBe(basename(origin?.senderPath ?? ""));
    expect(origin?.ancestry[0]?.uid).toBe(process.getuid?.() ?? -1);
    // The RECEIVER's parent at signal time is this test process too.
    expect(origin?.selfPpid).toBe(process.pid);
    // The production call site is an exit hook, not the signal listener — a
    // synchronous FFI read must still work there, and give the same answer.
    expect(readJson<SignalOrigin | null>(dir, "origin-at-exit.json")).toEqual(
      origin,
    );
  }, 60_000);

  test("a sender reaped before delivery still yields its pid, and says why the chain is empty", async () => {
    // `sh -c 'exec /bin/kill …'` exits the instant it has signalled. Whether it
    // survives long enough to be walked is a scheduling race NOBODY can win: the
    // handler is already the earliest observable moment, and a reaped pid cannot
    // be resolved by any mechanism. What must hold in BOTH outcomes is that the
    // record is unambiguous — either a real chain, or ESRCH saying the sender
    // was gone. An empty chain with no reason would be the absorbable failure.
    const dir = scratch();
    const proc = spawnFixture("listener", dir);
    const victimPid = await awaitReady(dir, proc);

    const killer = killFromShortLivedBinary(victimPid);
    const killerPid = killer.pid;
    await killer.exited;
    await awaitExit(proc);

    const origin = readJson<SignalOrigin | null>(dir, "origin.json");
    expect(origin?.senderPid).toBe(killerPid);
    if (origin?.ancestry.length === 0) {
      expect(origin.ancestryErrno).toBe(3); // ESRCH
    } else {
      expect(origin?.ancestry[0]?.comm).toBe("kill");
      expect(origin?.ancestryErrno).toBe(0);
    }
  }, 60_000);

  test("kernel/tty-generated signals are distinguishable from a process kill", async () => {
    const dir = scratch();
    const proc = spawnFixture("listener", dir);
    await awaitReady(dir, proc);

    // Bun.Subprocess.kill goes through the runtime, so si_pid names THIS
    // process rather than a `kill` binary — still a process, never 0.
    proc.kill("SIGTERM");
    await awaitExit(proc);

    const origin = readJson<SignalOrigin | null>(dir, "origin.json");
    expect(origin?.senderPid).toBe(process.pid);
    // si_code is stored RAW and never compared against SI_USER — darwin's own
    // header disagrees with what XNU delivers. Just assert it survived.
    expect(typeof origin?.siCode).toBe("number");
  }, 60_000);

  test("chaining is intact: the process.on listener still fires and still exits 143", async () => {
    // The regression that matters most — a tap that captured the signal without
    // chaining would break every graceful shutdown in the repo.
    const dir = scratch();
    const proc = spawnFixture("listener", dir);
    const victimPid = await awaitReady(dir, proc);

    const killer = killFromLivingSender(victimPid);
    await awaitExit(proc);
    killer.kill("SIGKILL");

    expect(readFileSync(join(dir, "events"), "utf8")).toContain(
      "listener-fired",
    );
    expect(proc.exitCode).toBe(143);
  }, 60_000);

  test("armed with no process.on, the SIG_DFL chain still kills the process", async () => {
    // Guards the old gateway shim's (`sigterm_darwin.go`) defect: it chained only when the
    // previous handler is neither SIG_DFL nor SIG_IGN. Under Bun's lazy install
    // that arm sees SIG_DFL, so copying it verbatim would make this process
    // ignore SIGTERM forever.
    const dir = scratch();
    const proc = spawnFixture("default-arm", dir);
    const victimPid = await awaitReady(dir, proc);

    const arm = readJson<SignalOriginArmResult>(dir, "arm.json");
    if (!arm.armed) throw new Error(`tap did not arm: ${arm.reason}`);

    const killer = killFromLivingSender(victimPid);
    await awaitExit(proc);
    killer.kill("SIGKILL");

    // Killed by the restored default disposition — never the 30s self-timeout.
    expect(proc.signalCode ?? `exit ${proc.exitCode}`).toBe("SIGTERM");
    expect(existsSync(join(dir, "events"))).toBe(false);
  }, 60_000);

  test("SINGULARITY_NO_SIGNAL_ORIGIN=1 fails open with a reason", async () => {
    const dir = scratch();
    const proc = spawnFixture("arm-only", dir, {
      SINGULARITY_NO_SIGNAL_ORIGIN: "1",
    });
    await awaitExit(proc);

    const arm = readJson<SignalOriginArmResult>(dir, "arm.json");
    expect(arm.armed).toBe(false);
    // The reason is the product, not a nicety: the caller records it so that
    // "no attribution" is itself on the record.
    expect(arm.armed === false && arm.reason).toContain(
      "SINGULARITY_NO_SIGNAL_ORIGIN",
    );
    expect(proc.exitCode).toBe(0);
  }, 60_000);
});
