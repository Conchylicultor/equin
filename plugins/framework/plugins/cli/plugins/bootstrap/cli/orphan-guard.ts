import { readEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
export const ORPHAN_EXIT_CODE = 140; // 128 + 12

// The poll installed by `installOrphanGuard`, held at module scope so
// `disarmOrphanGuard` can cancel it. `bin/index.ts` (which arms) and
// `bin/register-commands.ts` (which may disarm) both reach this module through
// the same relative specifier, so they share one instance — there is no handle
// to thread through the bootstrap.
let orphanPoll: ReturnType<typeof setInterval> | null = null;

// A foreground `./equin <anything>` dies with its invoker, so a CLI
// process can never hold or queue on a host lock after the shell that started it
// is gone. macOS has no PDEATHSIG, so a child cannot ask the kernel to signal it
// when its parent dies — poll ppid instead (reparented orphans get ppid 1). The
// push mutex is the worst case: one serialized slot host-wide, so a single
// orphan-hold stalls every agent's push. Run onOrphan when reparented; unref so
// the timer never itself keeps the process alive.
//
// ARMED FOR EVERY COMMAND, and that is the whole design. This used to be armed
// only for a hardcoded {build, check, push} set matched against
// `process.argv[2]` in `bin/index.ts`, before any flag parsing — the last thing
// coupling the bootstrap to a list of command names. A CLI whose commands are
// plugin contributions cannot keep such a list: the bootstrap runs BEFORE the
// install, so it cannot load the declarations that would tell it, and a second
// hand-maintained copy would only be as good as the check holding it in sync.
//
// Arming unconditionally deletes the question. The cost is one unref'd 2s timer
// on commands that finish in seconds; the benefit is that a NEW command is
// guarded by default rather than by remembering to enlist it, and that the
// window is now covered for the whole process — install included, which is where
// an orphan could previously sit on the one lock every other CLI invocation in
// this checkout queues behind.
//
// The safe default being ON means the opt-out is the declared exception: see
// `detachable` in `core/internal/command.ts` and `disarmOrphanGuard` below.
export function installOrphanGuard(onOrphan: () => void): void {
  // The detached self-restart build (build/run-build.ts) sets this and INTENDS
  // to outlive the backend it restarts — it must never self-terminate on reparent.
  // Env rather than a declaration because it is set by the SPAWNER, before this
  // process exists, and so is knowable here in the pre-install phase.
  if (readEnv("BUILD_DETACHED")) return;
  if (process.ppid === 1) {
    onOrphan();
    return;
  } // already orphaned at launch
  orphanPoll = setInterval(() => {
    if (process.ppid === 1) onOrphan();
  }, 2000);
  orphanPoll.unref();
}

// Cancel the guard for a command that is MEANT to outlive its invoking shell —
// `serve-app` boots a full runtime a caller may legitimately `nohup`. Called by
// the commander mapper as such a command begins, i.e. after argv has been
// parsed, which is the earliest point at which the resolved command is known.
//
// The gap between arming and here is deliberate: a detachable command orphaned
// during its own startup has begun nothing worth preserving, so exiting is
// correct. Idempotent, so a command may call it without checking.
export function disarmOrphanGuard(): void {
  if (orphanPoll === null) return;
  clearInterval(orphanPoll);
  orphanPoll = null;
}
