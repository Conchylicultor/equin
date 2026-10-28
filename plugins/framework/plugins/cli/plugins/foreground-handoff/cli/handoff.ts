import { spawn } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  watch,
  writeSync,
} from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import {
  setEnv,
  unsetEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { AWAIT_EXIT } from "@plugins/framework/plugins/cli/plugins/await/core";
import type { HandoffOp } from "../core";

const READ_CHUNK_BYTES = 64 * 1024;

/** Signals that end this launcher gracefully — and, with it, the op it owns. */
const ENDING_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + constants.signals[signal];
}

/**
 * Run `op` — this very invocation — as a detached child, stream its output as
 * if it ran here, and hand it off at `deadlineMs` if it has not finished.
 *
 * Why a child from the start: an op cannot be detached halfway. Its liveness
 * marker is a flock its process holds and its workers are its children, so the
 * process that must survive the call has to be the one that started the op.
 * This process is only a launcher — it writes no marker and takes no grant.
 *
 * - **Finishes in time:** its output was streamed as it came, and its exit
 *   code is this process's — indistinguishable from running in place.
 * - **Deadline:** print where it stands and how to get its verdict, leave it
 *   running, exit 70 (`./equin await`'s "still running" code). The op's
 *   orphan guard is disarmed (`OP_HANDED_OFF`), so this exit does not kill it.
 * - **This launcher is interrupted or orphaned** before the deadline (the user
 *   stopped the call): the op is SIGTERMed with it, as an in-place op would
 *   have died — a hand-off is the deadline's answer, not an interrupt's.
 *
 * The output goes to a file, never a pipe: a pipe dies with its reader, and the
 * op must keep writing after this process is gone.
 */
export async function runHandedOff(
  op: HandoffOp,
  deadlineMs: number,
): Promise<never> {
  const logPath = join(
    mkdtempSync(join(tmpdir(), `equin-${op}-`)),
    "output.log",
  );
  const writeFd = openSync(logPath, "a");
  const env = { ...process.env };
  unsetEnv("FOREGROUND_DEADLINE", env);
  setEnv("OP_HANDED_OFF", "1", env);
  const child = spawn(process.execPath, process.argv.slice(1), {
    cwd: process.cwd(),
    env,
    detached: true,
    stdio: ["ignore", writeFd, writeFd],
  });
  closeSync(writeFd);

  let handedOff = false;
  process.on("exit", () => {
    if (handedOff || child.pid === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      // The whole group: the op and every worker it started.
      process.kill(-child.pid, "SIGTERM");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
  });
  for (const sig of ENDING_SIGNALS)
    process.on(sig, () => process.exit(signalExitCode(sig)));

  const readFd = openSync(logPath, "r");
  let offset = 0;
  // Synchronous writes: every byte must be out before `process.exit`.
  const pump = () => {
    for (;;) {
      const chunk = Buffer.alloc(READ_CHUNK_BYTES);
      const n = readSync(readFd, chunk, 0, chunk.length, offset);
      if (n <= 0) return;
      offset += n;
      writeSync(1, chunk.subarray(0, n));
    }
  };
  const watcher = watch(logPath, () => pump());

  type Ending = { kind: "exited"; code: number } | { kind: "deadline" };
  const ending = await new Promise<Ending>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      resolve({
        kind: "exited",
        code: code ?? (signal ? signalExitCode(signal) : 1),
      }),
    );
    // One-shot: the deadline is an instant, not a loop.
    setTimeout(
      () => resolve({ kind: "deadline" }),
      Math.max(0, deadlineMs - Date.now()),
    ).unref();
  });
  watcher.close();
  pump();
  closeSync(readFd);

  if (ending.kind === "exited") process.exit(ending.code);

  handedOff = true;
  child.unref();
  writeSync(
    1,
    `\n⏸ ${op} is still running — handed off before this call's time limit; it keeps going on its own (pid ${child.pid}).\n` +
      `  Next: \`./equin await ${op}\` (foreground). It blocks until the ${op} writes its verdict and prints it; ` +
      `exit 70 means still going — call it again. No notification will come, so do not end your turn waiting for one.\n` +
      `  Its full output, so far and from here on: ${logPath}\n`,
  );
  process.exit(AWAIT_EXIT.stillRunning);
}
