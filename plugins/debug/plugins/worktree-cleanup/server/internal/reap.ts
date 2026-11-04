import { rm } from "node:fs/promises";
import { stat } from "@plugins/packages/plugins/timed-fs/core";
import { configDir } from "@plugins/config_v2/data-dirs";
import {
  databaseExists,
  dropDatabase,
} from "@plugins/database/plugins/admin/server";
import {
  ensureMainWorktreeRoot,
  isCanonicalWorktreePath,
  removeWorktree,
  removeWorktreeSpec,
} from "@plugins/infra/plugins/worktree/server";
import {
  namespacesOwnedByCheckout,
  reclaimNamespace,
} from "@plugins/infra/plugins/worktree/plugins/reclaim/server";
import type { ReapStep } from "../../shared/endpoints";

export async function dirExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return false;
  }
}

// The canonical reap sequence shared by the manual delete handlers and the
// automatic reaper job: remove the git worktree (if its dir is still present),
// reclaim every namespace the checkout MINTED, then reclaim the checkout's own
// namespace — drop its fork DB, remove its config dir, and finally remove its
// gateway registry entry (which deregisters the namespace + frees its watch).
//
// `onStep` lets the streaming delete handlers surface per-step progress to the
// UI without duplicating the sequence; the background job passes nothing.
export async function reapAttempt(
  id: string,
  opts: {
    worktreePath?: string;
    onStep?: (step: ReapStep) => void;
  },
): Promise<void> {
  if (opts.worktreePath) {
    const root = await ensureMainWorktreeRoot();
    // Deliberately NOT gated on the directory still existing, which is what this
    // used to check. Agent checkouts are now `git worktree lock`ed against Claude
    // Code's sweep of `.claude/worktrees/`, and a lock outlives the directory: if
    // something deletes the tree behind our back, `git worktree prune` SKIPS the
    // locked registration — silently, forever — so a "the dir is already gone,
    // nothing to do" early return would leak one `.git/worktrees/<name>` entry per
    // external deletion. `removeWorktree` reclaims both states: it unlocks and
    // removes a live registration, and falls through to prune when there is none.
    if (isCanonicalWorktreePath(opts.worktreePath, root)) {
      opts.onStep?.("worktree");
      await removeWorktree(opts.worktreePath);
    }
  }

  // The namespaces this checkout MINTED by building a composition —
  // `<composition>.<id>`, each one its own database, config dir and gateway
  // registration. ASKED FOR, never enumerated: this function does not know what
  // kinds of namespace a checkout can leave behind, so a kind invented later is
  // reclaimed here with no edit. Nothing swept these before, which is why there
  // is a backlog of them on this machine.
  //
  // Reclaimed BEFORE the checkout's own artifacts below, so a failure among them
  // is discovered while the checkout's own state is still intact and consistent.
  opts.onStep?.("namespaces");
  const derivedFailures = await reclaimDerivedNamespaces(id);

  // The checkout's OWN namespace, still an inline sequence rather than a
  // `reclaimNamespace(id)` call — and that is a deliberate split, not leftover
  // duplication. `reclaimNamespace`'s first guard refuses any namespace with no
  // `composition.json` marker, precisely because a marker-less registry dir
  // belongs to a git checkout of the same name and reclaiming it is THIS
  // function's job. A checkout's own namespace never carries a marker, so it can
  // never pass that guard. Sharing the code would mean weakening the guard to
  // admit marker-less namespaces — trading the one signal that keeps "reclaim a
  // served composition" and "reap a checkout" apart for the removal of ~12 lines.
  // The two ARE different things; the guard says so, and the duplication is the
  // price of it saying so.
  opts.onStep?.("database");
  // The fork DB may already be gone — an earlier reap dropped it, or a legacy
  // registry-only entry never had one — so the drop runs only when it exists.
  if (await databaseExists(id)) {
    await dropDatabase(id);
  }

  opts.onStep?.("config");
  // The reaped worktree's subtree of config_v2's declared user-config directory
  // — read from that plugin's own declaration, so the two halves of the
  // fork-here/reap-there pair can never name different directories.
  await rm(configDir.file(id), { recursive: true, force: true });

  // Deleting the spec file is how the gateway deregisters (its fsnotify Remove
  // handler calls registry.remove()) and frees the worktree's fsnotify watch.
  opts.onStep?.("registry");
  await removeWorktreeSpec(id);

  // Contained, then loud. A namespace whose database will not drop must not cost
  // the checkout its own reclaim — that is why the failures were collected rather
  // than thrown where they happened — but containment must not mean silence, so
  // the reap fails once everything reclaimable has been reclaimed. The caller's
  // own containment takes it from here: the sweep logs + reports it and moves to
  // the next target, and the delete handler streams it to the row. Retrying is
  // the marker-owned branch of `collectReapable`'s job, not a loop here: the
  // checkout is gone, so the namespace is exactly what that branch enumerates.
  if (derivedFailures.length > 0) {
    throw new Error(
      `reaped checkout "${id}", but ${derivedFailures.length} namespace(s) it ` +
        `owned could not be reclaimed: ${derivedFailures.join("; ")}`,
    );
  }
}

// Reclaim every namespace owned by this checkout, returning one message per
// failure — a list of failures, never a boolean or a swallowed error: the caller
// throws on a non-empty result, and each entry names the namespace so a report
// says WHICH one is stuck rather than that something was.
async function reclaimDerivedNamespaces(checkout: string): Promise<string[]> {
  const failures: string[] = [];
  // Serial on purpose: each reclaim drops a database, and the sweep already runs
  // three checkouts at once — fanning out here would multiply that against a
  // Postgres cluster the whole machine shares.
  for (const { ns } of await namespacesOwnedByCheckout(checkout)) {
    try {
      await reclaimNamespace(ns);
    } catch (err) {
      failures.push(`${ns}: ${String(err)}`);
    }
  }
  return failures;
}
