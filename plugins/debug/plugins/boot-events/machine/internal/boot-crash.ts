import { relative, sep } from "node:path";
import {
  getBootMode,
  isProcessCrashHandled,
  type Registration,
} from "@plugins/framework/plugins/server-core/core";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import {
  fileReportFromProcess,
  mergeBaseWithMain,
  type ProcessReport,
} from "@plugins/reports/plugins/outbox/core";

// A boot that throws must reach Reports. The process's crash listeners
// (server-core's, installed before the graph loads) dispatch to the reports
// engine's handler on `processCrashSink`, which attaches in the engine's
// `onReadyBlocking` — so an error thrown before then — a failed migration, a
// boot assert, a bad config — would reach no handler, and was on the backend's
// stderr only:
// the build that spawned it prints it, but a boot no build watches (a cold
// start on a page load, the gateway respawning main) reached nothing. The boot
// watchdog used to catch those under the wrong name (a crash read as a
// "wedge", its un-ready time running to the next boot); now that a crashed
// boot is told apart (the `exited` line), the crash itself is the report.
//
// Through the report outbox, not `recordReport`: a backend that crashes in
// boot has no working server to record with, and may never come back to drain
// a local buffer. Main drains the outbox — for its own crashed boot too, once
// it is up again.

/** The repo files on the top frames — what the outbox's staleness rule compares. */
const CODE_FRAMES = 3;

export function bootCrashReport(
  worktree: string,
  err: unknown,
  base: { mergeBase: string } | null,
): ProcessReport {
  const error = err instanceof Error ? err : new Error(String(err));
  const stack = error.stack ?? null;
  return {
    kind: "crash",
    message: `Backend of ${worktree} crashed during boot: ${error.message}`,
    data: { errorType: error.name, stack },
    // Main drops the report when it has changed these files since this
    // checkout branched — the bug may already be fixed there.
    ...(base !== null
      ? {
          code: {
            mergeBase: base.mergeBase,
            paths: stackRepoPaths(stack ?? ""),
          },
        }
      : {}),
  };
}

/** Repo-relative paths of the stack's first frames inside this checkout (no deps). */
export function stackRepoPaths(
  stack: string,
  root: string = REPO_ROOT,
): string[] {
  const paths: string[] = [];
  for (const m of stack.matchAll(/(\/[^\s():]+\.[cm]?[jt]sx?):\d+(?::\d+)?/g)) {
    const rel = relative(root, m[1]!);
    if (rel.startsWith("..") || rel.split(sep).includes("node_modules"))
      continue;
    if (!paths.includes(rel)) paths.push(rel);
    if (paths.length === CODE_FRAMES) break;
  }
  return paths;
}

/**
 * File one boot crash, then exit 1. The listener that calls this replaced the
 * runtime's own crash handling, so it does what that did — print the error
 * (the gateway quotes the backend's last stderr lines back to the build) and
 * exit non-zero — with the filing in between.
 */
export async function fileBootCrashAndExit(
  worktree: string,
  err: unknown,
): Promise<never> {
  console.error(err);
  const base = await mergeBaseWithMain(REPO_ROOT);
  if (!base.ok)
    console.error(
      `[boot] boot-crash report filed without its branch point: ${base.reason}`,
    );
  const filed = await fileReportFromProcess(
    bootCrashReport(worktree, err, base.ok ? base : null),
  );
  if (filed.outcome !== "written") {
    console.error(
      `[boot] the boot-crash report could not be filed (${filed.outcome})`,
    );
  }
  process.exit(1);
}

// Until `ready`, an uncaught throw or rejection is a boot crash: filed, then
// exit 1. Serve only — an `exec` child is a supervised run with its own
// failure path, and never reaches `ready` to disarm.
let crashing = false;

function onBootCrash(err: unknown): void {
  // Once a handler is attached to `processCrashSink` (the reports engine's),
  // the framework's listener files through it and owns the process's crashes
  // from then on — including keeping it alive on a rejection it treats as
  // recoverable. Until then, that listener stands down for this one.
  if (isProcessCrashHandled()) return;
  // A second throw while the first is being filed changes nothing: the
  // process is already on its way out with the first.
  if (crashing) return;
  crashing = true;
  void runTracked("boot-events.boot-crash", () =>
    fileBootCrashAndExit(runtimeNamespace(), err),
  );
}

export const bootCrashRegistration: Registration = {
  register() {
    if (getBootMode() !== "serve") return;
    process.on("uncaughtException", onBootCrash);
    process.on("unhandledRejection", onBootCrash);
  },
};

/** Once ready, `processCrashSink`'s handler owns the process's crashes. */
export function disarmBootCrash(): void {
  process.off("uncaughtException", onBootCrash);
  process.off("unhandledRejection", onBootCrash);
}
