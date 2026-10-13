import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import {
  defineFileWatcher,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { currentBranchRef } from "./current-branch-ref";
import { gitCommonDir } from "./git-common-dir";
import { readSha } from "./read-sha";
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

// The reconcile tick (30s) is the safety net for packed-refs-only movement,
// which writes no loose ref under refs/ and so fires no event.
export const gitRefsWatcher = defineFileWatcher({
  name: "git-watcher.refs",
  description:
    "Watches the repository's loose git refs and, when main or this worktree's branch moves, re-reads its sha and announces the advance.",
  reconcileMs: 30_000,
});

const lastKnownSha = new Map<string, string | null>();
let watcher: FileWatcher | null = null;
let started = false;

// One recompute at a time — a change and a reconcile tick included — with the
// triggers landing mid-run folded into one trailing recompute. Each re-reads
// every tracked ref's current sha, so overlapping runs would only interleave
// on `lastKnownSha` (and double-announce an advance).
const recomputes = createCoalescer({
  run: () => runTracked("git-watcher:recompute", () => recompute()),
});

// The last `refs/heads/main` sha the watcher has observed, or null if not yet
// seeded. Lets the commits-graph probe fingerprint `main` with zero subprocess.
// `lastKnownSha` itself stays module-private — callers only read this getter.
// A null result means "watcher not yet seeded" (never trust it as
// "main unchanged"): the caller must fall back to an ungated `rev-parse main`.
export function lastKnownMainSha(): string | null {
  return lastKnownSha.get("refs/heads/main") ?? null;
}

export async function startGitWatcher(): Promise<void> {
  if (started) return;
  started = true;

  let commonDir: string;
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

  // Watch ONLY `${commonDir}/refs` — the loose-ref tree (incl. refs/heads).
  //
  // We deliberately do NOT watch the whole `.git` common dir. That dir is
  // SHARED by every linked worktree (1000+ here) and its object store is
  // high-churn: every fetch / commit / gc across all of them writes under
  // `objects/`, and each worktree's gitdir churns HEAD/logs/index. Watching it
  // fires a `recompute()` (which spawns `git rev-parse` per tracked ref) on
  // thousands of changes that can never move a ref — pure wasted event +
  // subprocess churn on every backend. `refs/` is a handful of small text
  // files that only change on an actual ref advance.
  //
  // A normal commit/fetch/rebase writes the loose ref under refs/heads/ (or
  // deletes it when packing) → we get the event and re-read the true sha via
  // `git rev-parse` (which also resolves packed-refs). The reconcile timer is
  // the safety net for packed-refs-only movement.
  //
  // The refs dir is shared by every worktree, so a change is only worth a
  // recompute when it writes a tracked ref (its loose file or its lock).
  const tracked = new Set(
    [...lastKnownSha.keys()].map((ref) => `${commonDir}/${ref}`),
  );
  const writesTracked = (path: string) =>
    tracked.has(path.endsWith(".lock") ? path.slice(0, -".lock".length) : path);
  watcher = await gitRefsWatcher.start({
    dirs: [`${commonDir}/refs`],
    onChange: (events) =>
      events.some((e) => writesTracked(e.path)) ? recomputes.run() : undefined,
    onReconcile: () => recomputes.run(),
  });
}

export async function stopGitWatcher(): Promise<void> {
  if (!started) return;
  started = false;
  if (watcher) {
    await watcher.stop();
    watcher = null;
  }
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
