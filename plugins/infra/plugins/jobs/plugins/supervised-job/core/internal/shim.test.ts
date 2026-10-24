/**
 * The shim is tested by RUNNING it, against the real `/bin/sh`.
 *
 * There is nothing here that could be asserted about the script as a string.
 * Everything it claims — that `$?` is captured before anything else clobbers
 * it, that an argument containing a space or a quote survives, that a trapped
 * signal lets `wait` return `128+signo` instead of killing the shell outright,
 * that a SIGKILL leaves nothing behind — is a fact about a POSIX shell's
 * behaviour, and the only way to know it holds on this machine's `sh` is to
 * spawn one. So these tests spawn detached children and signal their process
 * groups exactly as `killSupervisedRun` does.
 *
 * Run: `./equin test plugins/infra/plugins/jobs/plugins/supervised-job`
 */
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { afterEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/core";
import { readRunTerminal, type RunTerminal } from "./terminal";
import { supervisedArgv } from "./shim";

const dirs: string[] = [];

// The shim takes both paths from its caller and never reads their names, so a
// scratch pair needs no particular spelling.
function scratch(): { marker: string; transcript: string } {
  const dir = mkdtempSync(join(tmpdir(), "sg-shim-"));
  dirs.push(dir);
  return {
    marker: join(dir, "run-marker"),
    transcript: join(dir, "run-transcript"),
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Spawn `argv` under the shim, exactly as `startSupervisedRun` does. */
function spawnShim(
  argv: readonly string[],
  paths: { marker: string; transcript: string },
) {
  const shim = supervisedArgv(argv, paths.marker);
  const fd = openSync(paths.transcript, "a");
  try {
    return Bun.spawn(shim.argv, {
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
      detached: true,
      env: { ...process.env, ...shim.env },
    });
  } finally {
    closeSync(fd);
  }
}

async function runShim(
  argv: readonly string[],
): Promise<{ marker: string | null; transcript: string; exitCode: number }> {
  const paths = scratch();
  const proc = spawnShim(argv, paths);
  const exitCode = await proc.exited;
  return {
    marker: existsSync(paths.marker)
      ? readFileSync(paths.marker, "utf-8")
      : null,
    transcript: readFileSync(paths.transcript, "utf-8"),
    exitCode,
  };
}

describe("supervisedArgv — exit capture", () => {
  test("a clean exit records 0, and the shim exits 0 too", async () => {
    const result = await runShim(["/bin/sh", "-c", "echo hi; exit 0"]);
    expect(result.marker).toBe("0 -\n");
    expect(result.exitCode).toBe(0);
    expect(result.transcript).toBe("hi\n");
  });

  test("a non-zero exit records that exact code", async () => {
    const result = await runShim(["/bin/sh", "-c", "exit 7"]);
    expect(result.marker).toBe("7 -\n");
    expect(result.exitCode).toBe(7);
  });

  test("a command that does not exist records 127", async () => {
    // The shim must survive the failure of the thing it wraps: `$0` is
    // `supervised-run`, so the diagnostic in the transcript names the primitive
    // rather than a bare `sh`.
    const result = await runShim(["/no/such/binary"]);
    expect(result.marker).toBe("127 -\n");
    expect(result.transcript).toContain("supervised-run");
  });

  test("stdout and stderr land in ONE transcript, in order", async () => {
    // The accepted cost of the design, asserted rather than assumed:
    // interleaving order survives, the stdout/stderr classification does not.
    const result = await runShim([
      "/bin/sh",
      "-c",
      "echo one; echo two >&2; echo three",
    ]);
    expect(result.transcript).toBe("one\ntwo\nthree\n");
  });

  test("arguments containing spaces and quotes pass through untouched", async () => {
    // `"$@"` is what buys this: the argv arrives as real argv after `$0` and is
    // never interpolated into the script text, so there is no quoting to lose.
    const result = await runShim(["/bin/echo", "a b  c", "d'e", 'f"g']);
    expect(result.transcript).toBe(`a b  c d'e f"g\n`);
    expect(result.marker).toBe("0 -\n");
  });

  test("the marker is written atomically — no `.tmp` leftover on a clean run", async () => {
    const paths = scratch();
    const proc = spawnShim(["/bin/sh", "-c", "exit 0"], paths);
    await proc.exited;
    expect(existsSync(`${paths.marker}.tmp.${proc.pid}`)).toBe(false);
    expect(readFileSync(paths.marker, "utf-8")).toBe("0 -\n");
  });

  test("an empty argv is refused rather than spawning a bare shell", () => {
    expect(() => supervisedArgv([], "/tmp/x")).toThrow(/empty argv/);
  });
});

describe("supervisedArgv — signals", () => {
  test("a group SIGTERM records 143 and kills the child too", async () => {
    const paths = scratch();
    const proc = spawnShim(["/bin/sh", "-c", "echo started; sleep 30"], paths);
    // Give the child time to be in `sleep`, so the signal lands mid-run.
    await sleep(400);
    // The whole process group, exactly as `killSupervisedRun` signals it. The
    // shim alone would leave the real work running and reparented.
    process.kill(-proc.pid, "SIGTERM");
    await proc.exited;
    expect(readFileSync(paths.marker, "utf-8")).toBe("143 TERM\n");
    expect(readFileSync(paths.transcript, "utf-8")).toBe("started\n");
  });

  test("a group SIGHUP records HUP", async () => {
    const paths = scratch();
    const proc = spawnShim(["/bin/sh", "-c", "sleep 30"], paths);
    await sleep(400);
    process.kill(-proc.pid, "SIGHUP");
    await proc.exited;
    expect(readFileSync(paths.marker, "utf-8")).toBe("129 HUP\n");
  });

  test("SIGINT is RECORDED but does not cancel — the child runs to completion", async () => {
    // POSIX makes a non-interactive shell set SIGINT to ignore for the commands
    // of an asynchronous list, and ignore is inherited across exec — so the
    // supervised child never sees it. The shim traps INT anyway so it does not
    // die and orphan the child; the honest record is then "a signal arrived AND
    // the run finished successfully". `killSupervisedRun` uses SIGTERM.
    const paths = scratch();
    const proc = spawnShim(["/bin/sh", "-c", "sleep 1; echo done"], paths);
    await sleep(300);
    process.kill(-proc.pid, "SIGINT");
    await proc.exited;
    expect(readFileSync(paths.marker, "utf-8")).toBe("0 INT\n");
    expect(readFileSync(paths.transcript, "utf-8")).toBe("done\n");
  });

  test("a child that HANDLES TERM records its own exit code, and is gone first", async () => {
    // The `./equin build` shape (installFatalSignalExit): traps TERM,
    // shuts down, exits with its own status. A trapped signal makes `wait`
    // return 128+signo BEFORE the child has exited, so without the retry the
    // shim recorded `143 TERM` and exited while the child was still running —
    // reparented, unwatched, its real status thrown away.
    const paths = scratch();
    const proc = spawnShim(
      ["/bin/sh", "-c", "trap 'sleep 1; exit 42' TERM; sleep 30 & wait"],
      paths,
    );
    await sleep(500);
    process.kill(-proc.pid, "SIGTERM");
    await proc.exited;
    // Both facts survive: it WAS signalled, and the child chose 42.
    expect(readFileSync(paths.marker, "utf-8")).toBe("42 TERM\n");
    // And the shim outlived the child rather than the other way round.
    expect(
      Bun.spawnSync(["pgrep", "-f", "sleep 30"]).stdout.toString().trim(),
    ).toBe("");
  });

  test("a group SIGKILL leaves NO marker — the -1 sentinel's only cause", async () => {
    const paths = scratch();
    const proc = spawnShim(["/bin/sh", "-c", "echo started; sleep 30"], paths);
    await sleep(400);
    process.kill(-proc.pid, "SIGKILL");
    await proc.exited;
    // SIGKILL runs no shell, so nothing wrote the marker and nothing ever will.
    // This absence is the ONLY thing that means "hard-killed" — which is why
    // every other failure path above still writes one.
    expect(existsSync(paths.marker)).toBe(false);
  });
});

/**
 * THE pair. Two runs whose exit STATUS is identical and whose meaning is
 * opposite — one was killed, one chose to exit 143 — asserted through the real
 * shim and the real `readRunTerminal`, because everything in between them is
 * the mechanism that keeps them apart.
 *
 * `128 + signo` collapses these two into one number, which is how
 * `drun-1787890652933-wr3v6d` came to be recorded as `Exited with code 143`. If
 * anyone ever "improves" the shim by decoding `kill -l $((s-128))` when the
 * trap did not fire, the second case here starts reporting `TERM` and this test
 * is what says so.
 */
describe("a kill and a deliberate exit(143) are told apart", () => {
  // These two run against the REAL artifact paths, not a temp dir, so the
  // assertion goes through `readRunTerminal` — the function every consumer
  // actually calls — rather than re-parsing the marker in the test.
  const KIND = "shimtest";
  const worktree = runtimeNamespace();
  const written: string[] = [];

  afterEach(() => {
    for (const path of written.splice(0)) if (existsSync(path)) rmSync(path);
  });

  /** Run `argv` under the shim at the real marker path; `kill` signals the group mid-run. */
  async function runAt(
    runId: string,
    argv: readonly string[],
    kill?: NodeJS.Signals,
  ): Promise<RunTerminal | null> {
    mkdirSync(worktreeArtifacts.runsDir(worktree), { recursive: true });
    const marker = worktreeArtifacts.runTerminal(worktree, KIND, runId);
    const transcript = worktreeArtifacts.runTranscript(worktree, KIND, runId);
    written.push(marker, transcript);
    const proc = spawnShim(argv, { marker, transcript });
    if (kill) {
      await sleep(400);
      process.kill(-proc.pid, kill);
    }
    await proc.exited;
    return readRunTerminal(KIND, runId);
  }

  test("killed by a group SIGTERM ⇒ 143 WITH signalCode TERM", async () => {
    const terminal = await runAt(
      `killed-${Date.now().toString(36)}`,
      ["/bin/sh", "-c", "sleep 30"],
      "SIGTERM",
    );
    expect(terminal?.exitCode).toBe(143);
    expect(terminal?.signalCode).toBe("TERM");
  });

  test("a program that runs `exit 143` ⇒ the SAME 143 with signalCode NULL", async () => {
    const terminal = await runAt(`chose-${Date.now().toString(36)}`, [
      "/bin/sh",
      "-c",
      "exit 143",
    ]);
    expect(terminal?.exitCode).toBe(143);
    expect(terminal?.signalCode).toBeNull();
  });
});
