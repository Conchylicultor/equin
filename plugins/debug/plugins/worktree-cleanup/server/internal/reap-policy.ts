import { readdir } from "node:fs/promises";
import { basename } from "node:path";
import {
  listAttempts,
  listTasks,
} from "@plugins/tasks/plugins/tasks-core/server";
import { listDatabases } from "@plugins/database/plugins/admin/server";
import { heavyReadSlotCount } from "@plugins/infra/plugins/host/plugins/host-read-pool/server";
import {
  MAIN_WORKTREE_NAME,
  asNamespace,
  isNamespace,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import {
  listWorktreeDirs,
  readCheckoutOwner,
  type CheckoutOwnerRead,
} from "@plugins/infra/plugins/paths/core";
import {
  ensureMainWorktreeRoot,
  hasCompositionMarker,
  isCanonicalWorktreePath,
  worktreePathFor,
  isCanonicalWorktreeName,
} from "@plugins/infra/plugins/worktree/server";
import {
  listCompositionNamespaces,
  type OwnedNamespace,
} from "@plugins/infra/plugins/worktree/plugins/reclaim/server";
import { worktreesDir } from "@plugins/infra/plugins/paths/server";
import { dirExists } from "./reap";
import { canClassifyOrphans, dirAgeMs, readWorktreeDirIndex } from "./dirs";
import {
  getGitHygiene,
  isSafeToReap,
  isTaskDeletable,
  needsHygiene,
  type GitHygiene,
} from "./safety";

// Abandonment backstop. Deliberately status-agnostic: it fires even for a task
// the 72h clean path refuses to touch (held, in-progress, dirty), so
// nothing can pin a worktree on disk forever. 90 days rather than 30 because a
// *held* task is parked work the user means to resume — the shorter floor was
// reaping held worktrees out from under them well before they came back — but a
// hard cleanup is still a hard cleanup, so the floor is raised, not removed.
export const AUTO_REAP_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// Canonical-shaped registry entry names on disk (new `<name>/` subdir or legacy
// flat `<name>.json`) under the gateway registry dir. A missing dir (ENOENT)
// yields an empty set; any other error is surfaced loudly.
async function readRegistryNames(): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    const entries = await readdir(worktreesDir(), { withFileTypes: true });
    for (const e of entries) {
      const name = e.isDirectory() ? e.name : e.name.replace(/\.json$/, "");
      if (isCanonicalWorktreeName(name)) names.add(name);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return names;
}

export interface ReapTarget {
  id: string;
  worktreePath?: string;
}

// The reaper's decision for ONE attempt, and the scan counters that make the
// residual git-probe count K measurable in the job log.
export interface ReapScan {
  targets: ReapTarget[];
  // Marker-owned namespaces whose owning checkout is gone — a SEPARATE list from
  // `targets`, not a variant of one. A checkout id and a composition namespace
  // are reclaimed by different functions (`reapAttempt` vs `reclaimNamespace`),
  // and keeping them in one list would let a caller hand either to either. See
  // the branch that fills this at the foot of collectReapable.
  namespaceTargets: NamespaceReapTarget[];
  // Attempt rows examined (the whole `attempts` table).
  scanned: number;
  // Rows with anything left to reclaim — a dir, a fork DB, or a registry entry.
  // The gap between this and `scanned` is the history the scan no longer pays for.
  candidates: number;
  // Git hygiene probes actually spawned. This is K: the number A4's negative
  // cache would exist to reduce, and the number that decides whether it is
  // needed at all.
  hygieneProbes: number;
}

// The attempt fields the classification reads. Structural on purpose: the pure
// classifier takes facts, never a live row, so the policy is unit-testable
// without a database.
export interface AttemptFacts {
  id: string;
  worktreePath: string;
  retained: boolean;
  createdAt: Date;
}

export interface ClassifyContext {
  hasDir: boolean;
  hasDB: boolean;
  hasRegistry: boolean;
  taskStatus: string | undefined;
  // The git hygiene answer, when it has already been obtained. Omitted on the
  // first (I/O-free) pass — the classifier then asks for it by returning
  // NEEDS_HYGIENE, and only for the rows where it can change the verdict.
  hygiene?: GitHygiene;
  now: number;
}

// "I cannot decide without a git probe." The third arm of the classification, so
// the caller — not the policy — owns when and how the subprocess fan-out runs.
export const NEEDS_HYGIENE = "needs-hygiene";
export type ClassifyResult = ReapTarget | null | typeof NEEDS_HYGIENE;

// The per-attempt reap decision, as a PURE function. Four ways to become a
// target, and the guard that outranks all of them:
//   - RETAINED: never a target, by any branch, including the hard floor.
//   - ORPHAN: worktree dir gone but a fork DB and/or registry entry linger →
//     drop them. Age-free, so its caller MUST confirm the "dir is gone" input
//     with a real stat (see collectReapable).
//   - CLEAN PATH (72h): dir present, no uncommitted changes + task done/dropped
//     + ≥72h —
//     the hygiene-aware "nothing to lose" set. The only branch needing a probe.
//   - HARD FLOOR (≥90d): abandonment backstop — takes even dirty dirs
//     and held tasks, which the clean path deliberately never reaps.
//
// "Retained" is USER INTENT (attempts_v.retained — no conversation left
// un-closed), NOT process liveness. This guard used to read `attempt.active`,
// the progress notion: a conversation whose agent process was killed to reclaim
// resources was written `gone`, flipping `active` false and handing this reaper
// the checkouts of 22 conversations the user could still resume. `gone` is not
// terminal — it is the exact status `resumeConversation` requires. Only an
// explicit close (`exit_clean` / the UI Exit actions) writes the terminal
// `done`, and only that clears `retained`.
export function classifyAttempt(
  attempt: AttemptFacts,
  ctx: ClassifyContext,
): ClassifyResult {
  // NEVER reap an attempt the user has not finished with. Checked first and
  // outside every other branch — including the age-free orphan branch and the
  // 90-day hard floor — because none of those represent user intent either.
  if (attempt.retained) return null;

  // Nothing left to reclaim — dir, fork DB, and registry entry all gone (a
  // fully-cleaned or malformed row). Skipping avoids perpetual no-op reaps.
  if (!ctx.hasDir && !ctx.hasDB && !ctx.hasRegistry) return null;

  const age = ctx.now - attempt.createdAt.getTime();

  if (!ctx.hasDir) {
    // Orphan: dir gone, but a fork DB and/or a gateway registry entry linger.
    return { id: attempt.id, worktreePath: attempt.worktreePath };
  }

  const taskDeletable = isTaskDeletable(ctx.taskStatus);
  const hardFloor = age >= AUTO_REAP_AGE_MS; // abandonment backstop

  // The verdict below is `isSafeToReap(...) || hardFloor`. `needsHygiene`
  // partitions the input space by whether the git answer can move that verdict
  // at all — so the two arms it excludes are decided here without a subprocess,
  // with exactly the result the full conjunction would have produced.
  if (hardFloor) return { id: attempt.id, worktreePath: attempt.worktreePath };
  if (!needsHygiene({ hardFloor, taskDeletable, ageMs: age })) return null;

  if (!ctx.hygiene) return NEEDS_HYGIENE;

  const safe = isSafeToReap({
    dirExists: true,
    dbPresent: ctx.hasDB,
    isDirty: ctx.hygiene.isDirty,
    taskDeletable,
    ageMs: age,
    retained: false, // proven above — a retained attempt already returned null
  });
  return safe ? { id: attempt.id, worktreePath: attempt.worktreePath } : null;
}

// A namespace the sweep may reclaim, paired with the checkout whose
// disappearance authorized it. The checkout name is carried for the log: every
// target here exists BECAUSE some checkout is gone, and this is the only trace of
// it left.
export interface NamespaceReapTarget {
  ns: Namespace;
  checkout: string;
}

export interface ClassifyOwnedContext {
  // Whether the owning checkout's dir is still on disk. MUST be a CONFIRMED
  // absence — see the readdir invariant in collectReapable: the dir set may skip
  // a stat when it FINDS the dir, but may never stand in for one when it does not.
  checkoutDirExists: boolean;
  // Whether the owning checkout's attempt is still retained — user intent, the
  // same guard that outranks every branch of classifyAttempt.
  retained: boolean;
}

// The per-namespace reap decision, as a PURE function — the marker-owned twin of
// classifyAttempt, and deliberately NOT a branch of it. Its input is a namespace
// carrying a provenance marker, not an attempt row, and its output is reclaimed
// by `reclaimNamespace`, not by `reapAttempt`.
//
// One way to become a target, and two guards that outrank it:
//   - RETAINED: the owning checkout's attempt is unfinished — never a target,
//     matching classifyAttempt's first guard for the same reason. What the user
//     has not finished with is not garbage, whatever else is true.
//   - OWNER PRESENT: the checkout is still on disk, so its namespaces are live.
//   - OWNER GONE: the checkout that minted this namespace is not on disk →
//     reclaim it. Age-free, matching the orphan branch above: the owner is gone,
//     the namespace cannot be rebuilt or meaningfully reached, and there is
//     nothing for a grace period to protect.
//
// The marker's three arms are rendered here, never collapsed, and this is the
// only place the rule lives:
//   - `checkout: "<name>"` → owned by that checkout; the only arm reachable here.
//   - `checkout: null` → owned by MAIN. `sonata` served from main holds real user
//     content and no checkout will ever disappear to authorize its removal, so it
//     is reclaimed only by deleting the composition, explicitly and confirmed.
//   - `checkout: undefined` → a marker written before the field existed. The
//     owner is UNKNOWN, and unknown is not absent: guessing here drops a database.
export function classifyOwnedNamespace(
  owned: OwnedNamespace,
  ctx: ClassifyOwnedContext,
): NamespaceReapTarget | null {
  const { checkout } = owned.marker;
  // `typeof === "string"` is what keeps the null and undefined arms out
  // structurally rather than by a rule someone has to remember.
  if (typeof checkout !== "string") return null;
  if (ctx.retained) return null;
  if (ctx.checkoutDirExists) return null;
  return { ns: owned.ns, checkout };
}

// How long a stamped namespace must go unused before its missing checkout
// authorizes a reclaim. The owner's absence is the evidence; the grace only
// keeps the sweep off a namespace a checkout is acting as right now (an op
// rewrites the stamp, so its mtime is the last use) and off a checkout that is
// briefly unreachable.
export const STAMPED_NAMESPACE_GRACE_MS = 24 * 60 * 60 * 1000;

// The per-namespace decision for a namespace no attempt row and no composition
// marker owns — a second clone's main checkout, an e2e's temp repo, a hand-made
// worktree — whose only provenance is the stamp its CLI wrote
// (`actAsCheckoutNamespace`). PURE: the caller confirms the checkout's absence
// with a real stat, as every other absence here is confirmed.
//
// Never a target:
//   - MAIN: the machine's main app. A moved main checkout would read as gone;
//     its namespace holds the main database.
//   - no stamp, or an unreadable one: unknown owner is not an absent owner.
//   - used within the grace period, or its checkout still on disk.
export function classifyStampedNamespace(
  ns: Namespace,
  owner: CheckoutOwnerRead,
  ctx: { checkoutExists: boolean; now: number },
): ReapTarget | null {
  if (ns === MAIN_WORKTREE_NAME) return null;
  if (owner.kind !== "stamped") return null;
  if (ctx.now - owner.lastUsedMs < STAMPED_NAMESPACE_GRACE_MS) return null;
  if (ctx.checkoutExists) return null;
  return { id: ns };
}

// Run `fn` over `items` with at most `limit` concurrent executions.
async function pMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

// Classifies every attempt/fork and returns the set safe to reap autonomously,
// sharing the SAME `isSafeToReap` predicate as the UI safe-to-delete badge
// (handle-list) so the scheduled reaper and the UI can never drift. The branch
// taxonomy lives on `classifyAttempt` above.
//
// COST SHAPE — this used to be O(attempts ever created), one `stat` per row,
// hourly and forever: ~3,900 rows against ~150 ids with anything left to
// reclaim, so ~96% of the scan proved a row was already fully cleaned. One
// `readdir` answers that for every row at once, so the attempt loop is now
// synchronous set lookups. `listAttempts()` stays — at ~2.7 ms it is the lookup
// for policy (`retained`, `createdAt`, `taskId`), not the driver.
export async function collectReapable(now: number): Promise<ReapScan> {
  const root = await ensureMainWorktreeRoot();
  const [attempts, tasks, databases, dirIndex] = await Promise.all([
    listAttempts(),
    listTasks(),
    listDatabases(),
    readWorktreeDirIndex(root),
  ]);

  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const dbSet = new Set(
    databases.filter((name) => isCanonicalWorktreeName(name)),
  );
  // A worktree's gateway spec file is an artifact to reclaim just like its fork
  // DB, so the on-disk registry set joins dbSet as a signal that an inactive
  // attempt whose dir is gone still has something to clean (its registry entry
  // anchors a gateway registration + fsnotify watch even after the DB is gone).
  const registrySet = await readRegistryNames();
  const targets = new Map<string, ReapTarget>();
  const seenAttemptIds = new Set<string>();

  for (const attempt of attempts) seenAttemptIds.add(attempt.id);

  // INVARIANT — THE READDIR SET MAY ONLY SKIP WORK, NEVER AUTHORIZE IT.
  // Every branch below whose destructive consequence depends on "the dir is
  // absent" keeps a real `dirExists` stat as a confirmation before emitting a
  // target. That is a handful of stats (bounded by the artifact count, not the
  // attempt count), and it makes the whole set-vs-stat divergence class — APFS
  // case-folding, NFD/NFC normalisation, dangling symlinks — unable to produce a
  // false "absent". The reverse direction is already conservative: a false
  // "present" merely routes the row through hygiene and the 72h / 90d floors.
  // DO NOT REMOVE THESE STATS AS AN OPTIMISATION — they are the only thing
  // standing between a set/stat disagreement and an over-reap.
  //
  // TRAP: `hasDir` reads the UNFILTERED `allNames`, never `dirIndex.canonical`.
  // The old `dirExists` returned true for any node type and any name; narrowing
  // to the isCanonicalWorktreeName-filtered canonical list would flip a regex-failing
  // dir to `!hasDir`, send it down the age-free orphan branch, and have
  // `reapAttempt` remove the dir with no hygiene check and no age floor.
  const { allNames } = dirIndex;

  let candidates = 0;
  const needProbe: AttemptFacts[] = [];
  const probeCtx = new Map<string, ClassifyContext>();

  for (const attempt of attempts) {
    // A path that is not a direct child of `<root>/.claude/worktrees/` is never
    // a removable dir — only its fork DB and registry entry are reclaimed — so
    // it reads as `!hasDir` unconditionally, and (as before the readdir) is
    // never stat'd at all.
    const canonicalPath = isCanonicalWorktreePath(attempt.worktreePath, root);
    const hasDir =
      canonicalPath && allNames.has(basename(attempt.worktreePath));
    const hasDB = dbSet.has(attempt.id);
    const hasRegistry = registrySet.has(attempt.id);
    if (hasDir || hasDB || hasRegistry) candidates++;

    const ctx: ClassifyContext = {
      hasDir,
      hasDB,
      hasRegistry,
      taskStatus: taskMap.get(attempt.taskId)?.status,
      now,
    };
    const decision = classifyAttempt(attempt, ctx);
    if (decision === null) continue;
    if (decision === NEEDS_HYGIENE) {
      needProbe.push(attempt);
      probeCtx.set(attempt.id, ctx);
      continue;
    }
    if (!hasDir && canonicalPath) {
      // Age-free orphan branch: confirm the absence with a real stat before
      // acting on it (see the invariant above). A dir the stat DOES find is
      // re-classified as present, which is bit-identical to the pre-readdir
      // behaviour — it may then need a probe like any other live checkout.
      if (await dirExists(attempt.worktreePath)) {
        const present: ClassifyContext = { ...ctx, hasDir: true };
        const redo = classifyAttempt(attempt, present);
        if (redo === NEEDS_HYGIENE) {
          needProbe.push(attempt);
          probeCtx.set(attempt.id, present);
        } else if (redo !== null) {
          targets.set(redo.id, redo);
        }
        continue;
      }
    }
    targets.set(decision.id, decision);
  }

  // The residual git fan-out: only the rows where the probe can still change the
  // verdict. Driven at the host heavy-read pool's own width so the pool is the
  // regulator — `getGitHygiene` takes a slot per probe, so a wider local cap
  // would only queue waiters, and a narrower one would leave slots idle.
  const hygiene = await pMap(needProbe, heavyReadSlotCount(), (attempt) =>
    getGitHygiene(attempt.worktreePath, { background: true }),
  );
  needProbe.forEach((attempt, i) => {
    const ctx = probeCtx.get(attempt.id)!;
    const decision = classifyAttempt(attempt, { ...ctx, hygiene: hygiene[i]! });
    // A probed row always has its dir present, so NEEDS_HYGIENE cannot recur.
    if (decision !== null && decision !== NEEDS_HYGIENE) {
      targets.set(decision.id, decision);
    }
  });

  // DB-only orphans: att-*/claude-* fork DBs with no matching attempt row. Reap
  // when the resolved worktree dir is absent (nothing to remove, just drop DB).
  // The set lookup skips the stat for ids whose dir is present; the stat still
  // CONFIRMS every absence before it authorizes a drop (invariant above).
  for (const id of dbSet) {
    if (seenAttemptIds.has(id) || targets.has(id)) continue;
    if (allNames.has(id)) continue;
    if (!(await dirExists(await worktreePathFor(id)))) {
      targets.set(id, { id });
    }
  }

  // Registry-file orphans: a spec entry on disk whose git worktree dir is gone
  // and which has NO attempt row (attempt-backed entries are reclaimed above via
  // the hasRegistry signal). These predate the attempt system or had their rows
  // deleted. Removing the spec file deregisters the namespace from the gateway
  // and frees its fsnotify watch (reapAttempt's "registry" step).
  for (const name of registrySet) {
    if (seenAttemptIds.has(name) || targets.has(name)) continue; // covered/active already
    if (allNames.has(name)) continue;
    if (!(await dirExists(await worktreePathFor(name)))) {
      targets.set(name, { id: name }); // no worktree dir: a true orphan
    }
  }

  // Dir orphans: a canonical worktree dir PRESENT on disk with no attempt row.
  // Every branch above is anchored to an attempt row, and the two orphan branches
  // fire only when the dir is already gone — so this state was unreachable, and
  // the 90-day backstop above could never fire on it. Such a dir sat on disk
  // forever (~1 GB of node_modules each once built), which is exactly what the
  // hard floor exists to prevent.
  //
  // Deliberately gated at the hard floor ONLY, never the 72h clean path: with no
  // attempt row there is no `active` flag to consult and no task to classify, so
  // age is the only evidence of abandonment available. The floor is also what
  // makes the setupWorktree race benign — a dir whose attempt row has not been
  // written yet is 90 days too young to be collected here.
  //
  // Gated on canClassifyOrphans even though the reap job is already main-only:
  // this is the one branch that removes a dir git still tracks and a task may
  // still own, so an absent attempt row must mean "abandoned", not "this DB is a
  // fork that never saw the row". Belt-and-braces against a future perWorktree.
  if (canClassifyOrphans()) {
    for (const { name, path } of dirIndex.canonical) {
      if (seenAttemptIds.has(name) || targets.has(name)) continue;
      if ((await dirAgeMs(path, now)) >= AUTO_REAP_AGE_MS) {
        targets.set(name, { id: name, worktreePath: path });
      }
    }
  }

  // MARKER-OWNED NAMESPACE ORPHANS — a SEPARATE UNIVERSE from every branch above,
  // for checkouts that left without a reap (deleted externally, or reaped before
  // this branch existed — there was a backlog of ~16 such databases on this
  // machine when it landed).
  //
  // DO NOT WIDEN `isCanonicalWorktreeName` TO ADMIT DOTTED NAMES. Every branch above
  // reads a name matching that regex as a CHECKOUT id and resolves a git worktree
  // path from it, so admitting `sonata` (owned by main — must NEVER be swept) or
  // `sonata.att-X` there would route a composition namespace through checkout
  // logic. This is a different enumeration answering a different question — the
  // namespaces carrying a provenance marker, and whether their OWNER is gone —
  // and its targets leave in their own list so nothing can hand one to
  // `reapAttempt`. The two sets cannot collide either: `<comp>.<checkout>` and a
  // bare composition id both fail isCanonicalWorktreeName.
  //
  // Gated on canClassifyOrphans for the same reason the dir-orphan branch is: the
  // `retained` input is read from the attempts table, which on a worktree backend
  // is a fork taken at checkout time and cannot see any attempt created since.
  const namespaceTargets: NamespaceReapTarget[] = [];
  if (canClassifyOrphans()) {
    const retainedCheckouts = new Set(
      attempts.filter((a) => a.retained).map((a) => a.id),
    );
    for (const owned of await listCompositionNamespaces()) {
      const { checkout } = owned.marker;
      // Already covered: a checkout in `targets` reclaims everything it owns
      // inside `reapAttempt`, so listing its namespaces here too would have the
      // second pass find a namespace that no longer exists and file a failure
      // report for work that succeeded. If that reap fails before reaching its
      // namespaces step, the next hourly tick collects them — the sweep is
      // idempotent, and the checkout is still a target.
      if (typeof checkout === "string" && targets.has(checkout)) continue;
      const decision = classifyOwnedNamespace(owned, {
        // Honours the readdir invariant above verbatim: the set may SKIP the stat
        // when it FINDS the dir, and an absence is confirmed with a real stat
        // before it authorizes a target. The arms that name no checkout have no
        // dir to look for, and `true` is the refusing value there — the fallback
        // can only decline a target, never mint one.
        checkoutDirExists:
          typeof checkout === "string"
            ? allNames.has(checkout) ||
              (await dirExists(await worktreePathFor(checkout)))
            : true,
        retained:
          typeof checkout === "string" && retainedCheckouts.has(checkout),
      });
      if (decision !== null) namespaceTargets.push(decision);
    }
  }

  // STAMP-OWNED NAMESPACE ORPHANS — the namespaces neither universe above can
  // name: not an attempt id (isCanonicalWorktreeName), not a composition (marker), so
  // no row and no marker will ever authorize their reclaim. Their owner is the
  // checkout stamped by its CLI. Reclaimed through `reapAttempt` with no
  // worktree path — its database, config dir and registry dir — because such a
  // namespace is a checkout's OWN namespace, exactly what that function reaps;
  // there is no git worktree of ours to remove.
  if (canClassifyOrphans()) {
    for (const name of listWorktreeDirs()) {
      if (!isNamespace(name) || isCanonicalWorktreeName(name)) continue;
      if (targets.has(name) || seenAttemptIds.has(name)) continue;
      const ns = asNamespace(name);
      if (hasCompositionMarker(ns)) continue;
      const owner = readCheckoutOwner(ns);
      if (owner.kind !== "stamped") continue;
      const decision = classifyStampedNamespace(ns, owner, {
        // Evaluated only when the verdict can depend on it; a real stat, per the
        // invariant above.
        checkoutExists:
          now - owner.lastUsedMs < STAMPED_NAMESPACE_GRACE_MS ||
          (await dirExists(owner.root)),
        now,
      });
      if (decision !== null) targets.set(decision.id, decision);
    }
  }

  return {
    targets: [...targets.values()],
    namespaceTargets,
    scanned: attempts.length,
    candidates,
    hygieneProbes: needProbe.length,
  };
}
