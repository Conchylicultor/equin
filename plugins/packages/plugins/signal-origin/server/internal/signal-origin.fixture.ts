/**
 * Subprocess fixture for `signal-origin.test.ts`.
 *
 * A signal handler can only be observed from OUTSIDE the process that installs
 * it: the test has to arm a tap, get a third party to signal it, and then look
 * at what the victim recorded. So every assertion in the suite needs a real
 * child, and this file is that child — one entry point with a mode argument,
 * rather than N nearly identical scripts.
 *
 * It lives in the repo (not a tmp dir) because Bun resolves the `@plugins/*`
 * tsconfig alias relative to the importing file's project; a script written to
 * `/tmp` cannot import this plugin at all.
 *
 * Protocol — files, never pipes. The child writes into `--out <dir>`:
 *   ready       its pid, once the tap is armed and it is safe to signal
 *   origin.json what `readSignalOrigin` returned in the signal handler
 *   arm.json    what `armSignalOrigin` returned
 *   events      one line per lifecycle event (`listener-fired`, …)
 * Files rather than stdout so the test never holds a pipe on a child it is
 * about to kill (bun 1.3.13 can wedge on exit-during-stream-pull), and so a
 * record written microseconds before death is still readable afterwards.
 *
 * `events` accumulates in memory and is REWRITTEN whole on each event rather
 * than appended to: a whole-file write is a single `write(2)` on a fresh fd, so
 * it is at least as atomic as an append and keeps both properties above — the
 * file is on disk, complete, before `event()` returns. Appends are reserved for
 * the bounded-append sink primitive, which is what owns rotation repo-wide.
 *
 * The shim comes from the real dependency cache: the suite ensures
 * `signal-origin-shim` before spawning this child, which takes it with
 * `readyNow` (this file is not test code, so it cannot mint a `Ready`).
 *
 * Usage: bun signal-origin.fixture.ts --mode <mode> --out <dir>
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readyNow } from "@plugins/infra/plugins/deps/deps";
import { signalOriginShim } from "../../deps";
import {
  armSignalOrigin,
  readSignalOrigin,
  type SignalOriginArmResult,
} from "./signal-origin";

const SIGTERM = 15;

function argValue(name: string): string {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined)
    throw new Error(`fixture: missing required argument ${name}`);
  return v;
}

const mode = argValue("--mode");
const outDir = argValue("--out");
const at = (name: string) => join(outDir, name);

const shim = await readyNow(signalOriginShim);

/** Arm from the ensured shim; a shim that is not installed is an unarmed result. */
function arm(): SignalOriginArmResult {
  if (shim.kind !== "ready") {
    return { armed: false, reason: `signal-origin-shim is ${shim.kind}` };
  }
  return armSignalOrigin(shim.ready, [SIGTERM]);
}

const events: string[] = [];

function event(line: string): void {
  events.push(line);
  writeFileSync(at("events"), events.map((l) => `${l}\n`).join(""));
}

function announceReady(): void {
  // Written last, so its existence means "armed — safe to signal now".
  writeFileSync(at("ready"), String(process.pid));
}

/** Keep the loop alive, with a hard cap so a wedged fixture can never linger. */
function stayAlive(): void {
  setTimeout(() => {
    event("timeout");
    process.exit(0);
  }, 30_000);
}

switch (mode) {
  /**
   * The production ordering: `process.on` FIRST (that is when Bun lazily
   * installs its own handler), then arm — so the tap captures Bun's handler as
   * the one to chain to.
   */
  case "listener": {
    // The production reader runs in an exit hook (`finalizeBuild`), where no
    // async work can run and Bun is tearing down — so the suite exercises that
    // context, not just the signal listener, and asserts the two agree.
    process.on("exit", () => {
      writeFileSync(
        at("origin-at-exit.json"),
        JSON.stringify(readSignalOrigin(SIGTERM)),
      );
    });
    process.on("SIGTERM", () => {
      event("listener-fired");
      const origin = readSignalOrigin(SIGTERM);
      writeFileSync(at("origin.json"), JSON.stringify(origin));
      process.exit(143);
    });
    writeFileSync(at("arm.json"), JSON.stringify(arm()));
    announceReady();
    stayAlive();
    break;
  }

  /**
   * The trap the gateway precedent would have walked into: armed with NO
   * `process.on`, so the captured previous disposition is SIG_DFL. If the tap
   * chained the way the old gateway shim did, this process would ignore SIGTERM
   * forever. It must still die.
   */
  case "default-arm": {
    writeFileSync(at("arm.json"), JSON.stringify(arm()));
    announceReady();
    stayAlive();
    break;
  }

  /**
   * Arm and report the result, nothing else — for the fail-open cases. Nothing
   * keeps the loop alive, so the process exits 0 on its own.
   */
  case "arm-only": {
    writeFileSync(at("arm.json"), JSON.stringify(arm()));
    break;
  }

  default:
    throw new Error(`fixture: unknown mode ${mode}`);
}
