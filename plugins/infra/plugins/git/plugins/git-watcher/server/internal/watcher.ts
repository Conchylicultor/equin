import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import {
  defineFileWatcher,
  WatchedDirGoneError,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { currentBranchRef } from "./current-branch-ref";
import { gitCommonDir } from "./git-common-dir";
import { readSha } from "./read-sha";
import { isDirOnDisk as isDir } from "./is-dir";
import { planRefFollow, samePlan, type RefFollowPlan } from "./ref-files";
import { refAdvanced } from "./tables-ref-advanced";
import { refHeadServed } from "./ref-head-resource";
import { runRefReactions } from "./reactions";

// Refs whose movement we surface via refHeadServed. Always `refs/heads/main`
// (the refAdvanced trigger event keys off it) plus, in a worktree, that
// worktree's own branch — the ref a local commit / rebase / sync-to-head
// advances. Together these are the only refs whose movement changes a
// commits-graph ahead/behind delta. Computed once at startup.
async function computeTrackedRefs(): Promise<string[]> {
  const refs = ["refs/heads/main"];
  if (!isMain()) {
    const branch = await currentBranchRef();
    if (branch && !refs.includes(branch)) refs.push(branch);
  }
  return refs;
}

// No timer, and no tree watch. The tracked refs are a handful of KNOWN files,
// so they are followed on kqueue (`writesWhileOpen`: milliseconds) rather than
// heard through a recursive FSEvents watch of `<common>/refs`, which is as late
// as fseventsd's queue — 25 s seen on main on 2026-11-09, leaving
// `lastKnownMainSha()` stale that long. What is followed and why: ./ref-files.ts.
// A ref advance is a lockfile renamed over the loose ref, which the patched
// kqueue backend reports as the ref file changing. A dropped event is reported
// by the watch (`onLost`).
export const gitRefsWatcher = defineFileWatcher({
  name: "git-watcher.refs",
  description:
    "Follows the loose ref files of main and this worktree's branch, and packed-refs; when one moves, re-reads its sha and announces the advance.",
  writesWhileOpen: true,
});

const lastKnownSha = new Map<string, string | null>();
let commonDir: string | null = null;
// The open follow; `gone` once one of its dirs went (it hears nothing there).
let followed: {
  plan: RefFollowPlan;
  watcher: FileWatcher;
  gone: boolean;
} | null = null;
let started = false;

// One recompute at a time — a change, a re-plan and a lost-events report
// included — with the triggers landing mid-run folded into one trailing run.
// Each re-reads every tracked ref's current sha, so overlapping runs would only
// interleave on `lastKnownSha` (and double-announce an advance). A "replan"
// item first brings the follow in line with the refs dirs as they are now.
const recomputes = createCoalescer<"replan">({
  run: (items) =>
    runTracked("git-watcher:recompute", async () => {
      if (items.length > 0) await follow();
      await recompute();
    }),
});

// The last `refs/heads/main` sha the watcher has observed, or null if not yet
// seeded. Lets the commits-graph probe fingerprint `main` with zero subprocess.
// `lastKnownSha` itself stays module-private — callers only read this getter.
// A null result means "watcher not yet seeded" (never trust it as
// "main unchanged"): the caller must fall back to an ungated `rev-parse main`.
export function lastKnownMainSha(): string | null {
  return lastKnownSha.get("refs/heads/main") ?? null;
}

/**
 * Open the follow the refs dirs call for now, then close the one it replaces
 * (opened first: both share each dir's subscription, so nothing goes unheard
 * between them). A no-op while the plan is unchanged and its watch is open.
 */
async function follow(): Promise<void> {
  if (!started || commonDir === null) return;
  const dir = commonDir;
  const refs = [...lastKnownSha.keys()];
  let plan = await planRefFollow(dir, refs, isDir);
  if (followed !== null && samePlan(followed.plan, plan) && !followed.gone) {
    return;
  }
  let watcher: FileWatcher;
  for (;;) {
    try {
      watcher = await openFollow(plan);
      break;
    } catch (err) {
      // A dir of the plan went while it opened (a nesting dir removed by a
      // pack): open what the dirs call for now. Anything else — or the same
      // plan failing again — is a real failure.
      const now = await planRefFollow(dir, refs, isDir);
      if (samePlan(now, plan)) throw err;
      plan = now;
    }
  }
  if (!started) {
    await watcher.stop(); // stopped while it opened
    return;
  }
  const previous = followed;
  followed = { plan, watcher, gone: false };
  await previous?.watcher.stop();
}

function openFollow(plan: RefFollowPlan): Promise<FileWatcher> {
  const watcher = gitRefsWatcher.start({
    files: [...plan.files],
    // A structural entry appearing (a branch's nesting dir created) re-plans;
    // a ref file or packed-refs changing re-reads the shas.
    onChange: (events) =>
      recomputes.run(
        events.some((e) => plan.structural.has(e.path)) ? ["replan"] : [],
      ),
    // A followed dir going (a nesting dir removed once its last loose ref was
    // packed) re-plans from the dirs that are left; any other loss re-reads.
    onLost: async (_dir, err) => {
      if (!(err instanceof WatchedDirGoneError)) return recomputes.run();
      const self = await watcher;
      if (followed?.watcher === self) followed.gone = true;
      return recomputes.run(["replan"]);
    },
  });
  return watcher;
}

export async function startGitWatcher(): Promise<void> {
  if (started) return;
  started = true;

  try {
    commonDir = await gitCommonDir();
  } catch (err) {
    console.error("[git-watcher] cannot resolve git common dir", err);
    return;
  }

  // Seed lastKnownSha without emitting — the watcher's contract is "fire on
  // advance from a known baseline." Consumers run their own startup catch-up
  // for "did anything change while I was down."
  for (const ref of await computeTrackedRefs()) {
    try {
      lastKnownSha.set(ref, await readSha(ref));
    } catch (err) {
      console.error(`[git-watcher] initial readSha(${ref}) failed`, err);
      lastKnownSha.set(ref, null);
    }
  }

  // The follow's first open hands an `update` for every followed file present
  // (it heard nothing before it opened), so a ref moved since the seed above
  // is re-read and announced. Through the coalescer, like every re-plan, so no
  // two follow() runs ever overlap (one would overwrite the other's plan).
  await recomputes.run(["replan"]);
}

export async function stopGitWatcher(): Promise<void> {
  if (!started) return;
  started = false;
  const current = followed;
  followed = null;
  await current?.watcher.stop();
}

async function recompute(): Promise<void> {
  for (const refName of lastKnownSha.keys()) {
    let sha: string | null;
    try {
      sha = await readSha(refName);
    } catch (err) {
      console.error(`[git-watcher] readSha(${refName}) failed`, err);
      continue;
    }
    const previousSha = lastKnownSha.get(refName) ?? null;
    if (sha === previousSha) continue;
    lastKnownSha.set(refName, sha);
    refHeadServed.notify({ refName });
    if (!sha) continue;
    // In-process reactions run in EVERY backend, before the durable emit. That
    // difference is load-bearing: `emit` is main-only, so anything that reacts
    // through the trigger event is structurally absent from every worktree
    // backend. Reactions are also the only path with nothing queued between the
    // ref moving and the work — see ./reactions.ts for when to use which.
    await runRefReactions({ refName, sha, previousSha });
    if (isMain()) {
      try {
        await refAdvanced.emit({ refName, sha, previousSha });
        // eslint-disable-next-line promise-safety/no-bare-catch
      } catch (err) {
        console.error(`[git-watcher] emit refAdvanced(${refName}) failed`, err);
      }
    }
  }
}
