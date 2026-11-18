import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, openSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MKFIFO } from "@plugins/infra/plugins/paths/server";

// ── the exit watchdog, outside the process ──────────────────────────────────
// The agent's own hard exit (`hardExit` in agent.ts) is JavaScript: a timer
// and a check after `process.exit` returns. Neither runs when the JavaScript
// thread itself is stuck — and the one place that is known to happen is the
// worst one: inside `process.exit`, after its `exit` listeners removed the pid
// file. From then on no backend can see the agent (they all reach it through
// that file), so nothing stops it: conv-1794147656-9o6et2 wrote `exited`,
// removed its pid file and ran for ten days (report-1795040580-ed6ikk).
//
// So the guarantee lives in another process: a bash helper started with the
// agent, holding the read end of a pipe whose only writer is the agent.
//
//   - the agent dies, however       → EOF → the helper exits, killing nothing
//   - the agent's exit begins (arm) → one line of what to write if it stalls;
//     then EOF within the grace period → the helper exits, killing nothing;
//     still open after it → the agent is alive (it holds the pipe): sample
//     it, append the `exit_stalled` line to its events, SIGKILL its children
//     (the CLI) and it
//
// Arming is one synchronous write(2) to the pipe, made before the pid file
// goes, so once the pid file is gone the exit is bounded whatever the
// JavaScript does next. A live pipe proves the pid is still the agent's, so
// the kill can never reach a recycled pid.
//
// The pipe is a FIFO, opened here with openSync and written with writeSync:
// a child's `stdin.write` is buffered by the event loop, and in an exit
// listener it never reached the helper (the test's wedged exit). The FIFO sits
// in a private temp dir — never the agent dir, whose kqueue watch opens every
// entry — and the helper removes both once it has opened it.

/** What the helper needs to report a stalled exit, given when arming. */
export interface ExitWatchdogPlan {
  /** The agent's `events.jsonl`, where the stall line is appended. */
  readonly eventsPath: string;
  /** The last seq the agent numbered; the stall line takes the next free one. */
  readonly seqFloor: number;
  /** Where the native stack sample goes. */
  readonly samplePath: string;
  /** The event line after `"seq":N,` when the sample was taken. */
  readonly sampledTail: string;
  /** The same when the sample failed. */
  readonly unsampledTail: string;
}

export interface ExitWatchdog {
  /** The helper's pid (for tests and the log). */
  readonly pid: number;
  /**
   * Start the grace period. Synchronous, once: a second call is ignored, so
   * every exit path can arm without knowing whether another already did.
   */
  arm(plan: ExitWatchdogPlan): void;
}

/** A field of the plan must fit on one line of the helper's protocol. */
function oneLine(value: string, name: string): string {
  if (value.includes("\n"))
    throw new Error(`exit watchdog: ${name} spans lines: ${value}`);
  return value;
}

/**
 * The helper. `read -t` tells a timeout from EOF by neither status nor output
 * in bash 3.2 (macOS's), so it is told by the time it took: the timeout is
 * one second over the grace, and anything at least the grace is a timeout.
 * Even an EOF misjudged at that edge only reaches `kill -0`, which a dead
 * agent fails.
 */
const SCRIPT = `
set -u
agent=$1 grace=$2 sample_bin=$3 fifo=$4
exec 0<"$fifo" || exit 1
rm -f "$fifo"
rmdir "\${fifo%/*}"
IFS= read -r events || exit 0
IFS= read -r floor || exit 0
IFS= read -r sample_path || exit 0
IFS= read -r sampled || exit 0
IFS= read -r unsampled || exit 0
start=$SECONDS
read -r -t $((grace + 1)) _
[ $((SECONDS - start)) -ge "$grace" ] || exit 0
kill -0 "$agent" 2>/dev/null || exit 0
"$sample_bin" "$agent" 1 -file "$sample_path" >/dev/null 2>&1 &
sampler=$!
( sleep 15; kill -KILL "$sampler" ) </dev/null >/dev/null 2>&1 &
bound=$!
if wait "$sampler"; then tail=$sampled; else tail=$unsampled; fi
{ kill "$bound"; wait "$bound"; } 2>/dev/null
last=$(sed -n 's/^{"seq":\\([0-9][0-9]*\\),.*}$/\\1/p' "$events" 2>/dev/null | tail -n 1)
seq=$floor
[ -n "$last" ] && [ "$last" -gt "$seq" ] && seq=$last
printf '{"seq":%s,%s\\n' $((seq + 1)) "$tail" >> "$events"
echo "$(date -u +%H:%M:%S) ● exit watchdog: agent $agent still running $grace s after its exit began — SIGKILL (its children first)"
pkill -KILL -P "$agent"
kill -KILL "$agent"
`;

/**
 * Start the helper for this process. Call before anything says the process
 * is alive (the pid file), so every exit that can follow is covered.
 */
export function startExitWatchdog(opts: {
  graceSeconds: number;
  sampleBin: string;
}): ExitWatchdog {
  if (!Number.isInteger(opts.graceSeconds) || opts.graceSeconds < 1)
    throw new Error(
      `exit watchdog: graceSeconds must be a whole number ≥ 1, got ${String(opts.graceSeconds)}`,
    );
  const fifoDir = mkdtempSync(join(tmpdir(), "equin-exit-watchdog-"));
  const fifo = join(fifoDir, "arm");
  const made = spawnSync(MKFIFO, [fifo], { encoding: "utf8" });
  if (made.status !== 0)
    throw new Error(
      `exit watchdog: mkfifo failed (${String(made.error?.message ?? made.status ?? made.signal)}): ${made.stderr}`,
    );
  const helper = spawn(
    "/bin/bash",
    [
      "-c",
      SCRIPT,
      "exit-watchdog",
      String(process.pid),
      String(opts.graceSeconds),
      opts.sampleBin,
      fifo,
    ],
    // Its own session: a signal to the agent's process group (the backend
    // stopping it) leaves the helper to see the agent's end. Its output joins
    // the agent's log.
    { detached: true, stdio: ["ignore", "inherit", "inherit"] },
  );
  // Never what keeps this process alive.
  helper.unref();
  const pid = helper.pid;
  if (pid === undefined)
    throw new Error("exit watchdog: /bin/bash did not start");
  // Blocks until the helper opens its end (milliseconds): from here the
  // helper is certainly watching. Close-on-exec, so no child inherits the
  // write end and keeps the helper from seeing this process end.
  const armFd = openSync(fifo, "w");
  let armed = false;
  return {
    pid,
    arm(plan) {
      if (armed) return;
      armed = true;
      const lines = [
        oneLine(plan.eventsPath, "eventsPath"),
        String(plan.seqFloor),
        oneLine(plan.samplePath, "samplePath"),
        oneLine(plan.sampledTail, "sampledTail"),
        oneLine(plan.unsampledTail, "unsampledTail"),
      ];
      const bytes = Buffer.from(`${lines.join("\n")}\n`);
      // Well under the pipe's 16 KiB buffer, but a short write is still
      // finished: the helper is reading.
      let off = 0;
      while (off < bytes.length) off += writeSync(armFd, bytes, off);
    },
  };
}
