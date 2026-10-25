// Relative sibling import: this file lives INSIDE the `paths` plugin, so the
// `@plugins/infra/plugins/paths/core` alias would cycle back through the barrel
// that re-exports it.
import { DATA_DIR_KINDS } from "./data-dir";
import type { DataDirRef } from "./data-dir";

// `DataDirRef` is defined beside the registry now — `MovedFrom` needs it, and
// this file imports `data-dir`, so defining it here would close a cycle. Still
// re-exported, so this module's surface is unchanged.
export type { DataDirRef } from "./data-dir";

// Where every pre-registry entry under the data root sits TODAY, and where it
// goes — ONE table, with two consumers that cannot drift from each other:
//
//   1. `paths/check/index.ts` derives its grandfathering from these rows, and
//      VERIFIES it: a legacy name passes only if it is what its own row says it
//      must be — the compatibility symlink pointing at its declared target, or
//      absent, or (for a name pre-move code keeps replacing) the plain file it
//      leaves there. A legacy name sitting there as a real directory after the
//      move is a failure, not a tolerated leftover.
//   2. `paths/scripts/migrate-data-layout.ts` executes them.
//
// The migration cannot read its plan from the registry, because the same change
// DELETES every temporary `legacyLocation` block — the registry describes where
// things will be, this table describes where they are. That asymmetry is why the
// table exists at all, and why it is written out by hand rather than derived.
//
// **The whole file is self-liquidating.** Once `--drop-legacy` has run on every
// root that matters, this table, `planMigration`, the script, and the check's
// symlink-verified grandfathering rule are all deleted together. Nothing may be
// ADDED here: a new entry at the root is either something an owner must declare
// with `defineDataDir`, or an orphan for `deprecated/`.
//
// Node-free by construction — no `node:fs`, no `node:path`. Every path below is
// RELATIVE TO THE DATA ROOT and spelled with `/`. `planMigration` is pure: the
// script supplies the filesystem facts and executes the returned steps.

export type LegacyMove =
  /**
   * Rename the directory to `<kind>/<name>`, then SYMLINK the old name at it, so
   * a worktree still running pre-move code keeps reading and writing the same
   * bytes. There is exactly one copy, at the new path.
   *
   * When `from` is itself a KIND name (`logs`), no shim is planted and none can
   * be: the root entry must be the kind directory, so it cannot also be a
   * symlink into itself. Such a row is also self-nesting (`to` starts with
   * `from/`), which the planner performs as the three-step staging dance.
   */
  | { from: string; move: "dir"; to: DataDirRef }
  /**
   * Move the file — AND its rotation siblings `<from>.1` … `<from>.<keep>` —
   * INTO `<kind>/<name>/`, then symlink each old name at its new file. A family
   * moves together or history silently truncates: every reader passes
   * `includeRotated: true`.
   *
   * `keep` MIRRORS the owning `defineFileSink`'s own `keep` (rotation suffixes
   * are appended after the full name, so `x.jsonl` rotates to `x.jsonl.1`). It
   * is stated rather than derived because `file-sink` is a different plugin and
   * the sink registry is only populated once its owner's module has evaluated —
   * which a check or a one-off script must not depend on. `keep: 0` is a lone
   * file with no rotation family at all.
   */
  | { from: string; move: "file"; to: DataDirRef; keep: number }
  /**
   * NO SHIM CAN HOLD at this name, so none is planted and none may be.
   *
   * A shim works only for a writer that writes the BYTES BEHIND the name. Every
   * writer that writes the NAME ITSELF — `unlink`, an atomic `rename(tmp, name)`,
   * a log rotation renaming `x` to `x.1` — removes or replaces the symlink
   * instead of passing through it, so the shim is gone on the first write. Old
   * and new code write different paths for one release cycle, and
   * `--drop-legacy` sweeps whatever the old side left behind. `reason` states
   * the degradation.
   *
   * `leaves` is what pre-move code leaves at the root once it has written, and
   * it is why this is ONE arm rather than two: the check's expectation and the
   * apply plan both derive from it, so a row cannot claim a steady state its
   * writer does not produce.
   *
   *  - `"nothing"` — the writer creates and unlinks, so the name is normally
   *    absent (`duress.latch`, `push-holder.json`).
   *  - `"a file"` — the writer REPLACES the name, so a real file sits there
   *    until pass 2 sweeps it (`central-routes.json`).
   */
  | {
      from: string;
      move: "unshimmable";
      to: DataDirRef;
      leaves: "nothing" | "a file";
      reason: string;
    }
  /** No live owner. Move into `deprecated/<from>`. No shim, ever. */
  | { from: string; move: "quarantine"; reason: string };

const NOT_YET_MOVED_ROTATION = "rotation of a log family with no live owner";

export const LEGACY_LAYOUT: readonly LegacyMove[] = [
  // ── apps/ ────────────────────────────────────────────────────────────────
  { from: "attachments", move: "dir", to: "apps/attachments" },
  { from: "prototypes", move: "dir", to: "apps/prototypes" },
  { from: "wallpaper", move: "dir", to: "apps/wallpaper" },
  { from: "sonata", move: "dir", to: "apps/sonata" },

  // ── state/ ───────────────────────────────────────────────────────────────
  { from: "config", move: "dir", to: "state/config" },
  { from: "cost-usage", move: "dir", to: "state/cost-usage" },
  { from: "releases", move: "dir", to: "state/releases" },
  { from: "reports", move: "dir", to: "state/reports" },
  // The secrets pair: the key dir moves wholesale, and the encrypted blob —
  // a LOOSE FILE at the root today — moves INTO it. They must run dir-then-file,
  // and `planningOrder()` guarantees that from the rows themselves, so this
  // adjacency is only for a reader — moving either line changes nothing.
  { from: "secrets", move: "dir", to: "state/secrets" },
  { from: "secrets.json.enc", move: "file", to: "state/secrets", keep: 0 },
  { from: "auth", move: "dir", to: "state/auth" },
  {
    from: "central-routes.json",
    move: "unshimmable",
    leaves: "a file",
    to: "state/gateway",
    reason:
      "the build writes the manifest atomically — `writeFileSync(tmp)` then " +
      "`rename(tmp, dest)` — and a rename onto the shim replaces it with a real file, so the " +
      "shim does not survive the first build from a stale worktree. For one release cycle a " +
      "stale worktree's build refreshes a manifest nothing reads: the gateway is handed " +
      "`-central-routes-file` explicitly and reads only state/gateway/central-routes.json, so a " +
      "central route added or removed by a stale checkout is not routed until a current-code " +
      "build runs.",
  },
  { from: "database.json", move: "file", to: "state/db-config", keep: 0 },

  // ── cache/ ───────────────────────────────────────────────────────────────
  { from: "check-cache", move: "dir", to: "cache/check" },
  { from: "closure-cache", move: "dir", to: "cache/closure" },
  { from: "tsbuildinfo", move: "dir", to: "cache/tsbuildinfo" },
  { from: "web-artifacts", move: "dir", to: "cache/web-artifacts" },
  { from: "asset-mirror", move: "dir", to: "cache/asset-mirror" },
  { from: "layout-lab-cache", move: "dir", to: "cache/layout-lab" },
  {
    from: "prototype-thumbnails",
    move: "dir",
    to: "cache/prototypes-thumbnails",
  },
  { from: "native", move: "dir", to: "cache/signal-origin-native" },

  // ── locks/ ───────────────────────────────────────────────────────────────
  //
  // The seven LIVE host pools. Written out rather than derived from
  // `HOST_POOLS`: `host-admission` imports `paths`, so reading its pool table
  // from here would close a cycle — and these are historical facts about one
  // machine's disk, not a live view of the pool set. The three `*-slots` dirs
  // with no live pool are quarantined below.
  { from: "cpu-slots", move: "dir", to: "locks/cpu" },
  { from: "heavy-read-slots", move: "dir", to: "locks/heavy-read" },
  { from: "worktree-mutate-slots", move: "dir", to: "locks/worktree-mutate" },
  { from: "db-fork-slots", move: "dir", to: "locks/db-fork" },
  { from: "browser-fetch-slots", move: "dir", to: "locks/browser-fetch" },
  { from: "layout-geometry-slots", move: "dir", to: "locks/layout-geometry" },
  { from: "push-slots", move: "dir", to: "locks/push" },
  { from: "gateway.pid", move: "file", to: "locks/gateway", keep: 0 },
  {
    from: "duress.latch",
    move: "unshimmable",
    to: "locks/duress",
    leaves: "nothing",
    reason:
      "created and unlinked at runtime by the cluster sentinel, so a shim would be removed by the first clear. For one release cycle a stale worktree does not observe a duress episode — it writes MORE observability, never less.",
  },
  {
    from: "push-holder.json",
    move: "unshimmable",
    to: "locks/push",
    leaves: "nothing",
    reason:
      "written while a push holds the mutex and unlinked when it finishes, so a shim would be removed by the first release. For one release cycle a stale worktree's op-status still sees the push running (the flock probe reaches locks/push/slot-0.lock through the push-slots shim) but not who holds it.",
  },

  // ── logs/ ────────────────────────────────────────────────────────────────
  //
  // `logs` is a KIND name, so this row plants no shim and nests into itself —
  // see the `dir` docblock. The gateway is the only writer of these files, it is
  // restarted as part of the move, and it is handed `-log-dir` explicitly, so no
  // old writer survives to need one.
  { from: "logs", move: "dir", to: "logs/gateway" },
  { from: "op-log.jsonl", move: "file", to: "logs/op-log", keep: 3 },
  {
    from: "signal-origin.jsonl",
    move: "file",
    to: "logs/signal-origin",
    keep: 2,
  },
  {
    from: "build-progress.jsonl",
    move: "file",
    to: "logs/build-progress",
    keep: 2,
  },
  {
    from: "check-progress.jsonl",
    move: "file",
    to: "logs/check-progress",
    keep: 2,
  },

  // ── deprecated/ ──────────────────────────────────────────────────────────
  //
  // Quarantine, not deletion: every entry below has NO live owner and no
  // reference left in the repo, but "I could not find a reader" is not the same
  // fact as "there is no reader".
  {
    from: "eslint-closure-cache",
    move: "quarantine",
    reason: "superseded by cache/closure; nothing reads this name",
  },
  {
    from: "wedge-repro",
    move: "quarantine",
    reason: "one-off wedge reproduction captures; no reader in the repo",
  },
  {
    from: "wedge-captures-manual",
    move: "quarantine",
    reason: "hand-taken wedge captures; no reader in the repo",
  },
  {
    from: "scripts",
    move: "quarantine",
    reason: "hand-dropped scripts at the data root; no reader in the repo",
  },
  {
    from: "crashes",
    move: "quarantine",
    reason:
      "the pre-rename spelling of state/reports; the backup source's `crashes` arm was already dropped",
  },
  {
    from: "forensics",
    move: "quarantine",
    reason: "empty, zero references",
  },
  {
    from: "backups",
    move: "quarantine",
    reason:
      "a hand-made pg dump with no code owner at all — BACKUPS_DIR is outside the data root",
  },
  {
    from: "build-slots",
    move: "quarantine",
    reason: "no live host pool of this name; the build takes locks/cpu",
  },
  {
    from: "type-check-worker-background-slots",
    move: "quarantine",
    reason: "no live host pool of this name",
  },
  {
    from: "type-check-worker-interactive-slots",
    move: "quarantine",
    reason: "no live host pool of this name",
  },
  {
    from: "op-wedge-captures.log",
    move: "quarantine",
    reason: "wedge capture log with no live sink and no reader in the repo",
  },
  {
    from: "op-wedge-captures.log.1",
    move: "quarantine",
    reason: NOT_YET_MOVED_ROTATION,
  },
  {
    from: "op-wedge-captures.log.2",
    move: "quarantine",
    reason: NOT_YET_MOVED_ROTATION,
  },
  {
    from: "op-wedge-captures.log.3",
    move: "quarantine",
    reason: NOT_YET_MOVED_ROTATION,
  },
  {
    from: "push-contention.jsonl",
    move: "quarantine",
    reason: "superseded by logs/op-log; no reader in the repo",
  },
  {
    from: "build-log.jsonl",
    move: "quarantine",
    reason: "superseded by logs/build-progress; no reader in the repo",
  },
  {
    from: "push-8x3g-detached.log",
    move: "quarantine",
    reason: "one debugging session's stray capture",
  },
  {
    from: "push-8x3g-run.sh",
    move: "quarantine",
    reason: "one debugging session's stray script",
  },
  {
    from: "check-progress.jsonl.preformat.bak",
    move: "quarantine",
    reason: "hand-made backup taken before a reformat; nothing reads it",
  },
  {
    from: "push.lock",
    move: "quarantine",
    reason:
      "orphan; the live push mutex is locks/push/slot-0.lock, and the only other `push.lock` in the repo is a temp path in worktree-op.test.ts",
  },
];

// ── derived views of the table ───────────────────────────────────────────────

function isKindName(name: string): boolean {
  return (DATA_DIR_KINDS as readonly string[]).includes(name);
}

/**
 * Every root name a row accounts for: `from`, plus the computed rotation
 * siblings of a `file` row. Ordered oldest-rotation-last so a printed plan reads
 * live-file-first.
 */
export function rowRootNames(row: LegacyMove): string[] {
  if (row.move !== "file") return [row.from];
  const names = [row.from];
  for (let n = 1; n <= row.keep; n++) names.push(`${row.from}.${n}`);
  return names;
}

/**
 * True when the row plants a backwards-compatibility symlink at the old name.
 * False for `unshimmable` and `quarantine` (by contract) and for a row whose
 * `from` is a KIND name — the root entry there must BE the kind directory.
 *
 * A TYPE PREDICATE, not a boolean: a shimmed row always has a `to`, and saying
 * so in the signature is what lets a caller read `row.to` after the guard. As a
 * plain boolean it did not, and the resulting unnarrowed access read `.to` off
 * the `quarantine` arm — which has none.
 */
export function rowIsShimmed(
  row: LegacyMove,
): row is Extract<LegacyMove, { move: "dir" | "file" }> {
  if (row.move === "unshimmable" || row.move === "quarantine") return false;
  return !isKindName(row.from);
}

/**
 * What the check must find at the root for one legacy name to pass.
 *
 * A discriminated union rather than a boolean allowlist: blanket grandfathering
 * is what let the old hand-written list stay green while the entries underneath
 * it were still real directories nobody had moved.
 */
export type LegacyExpectation =
  /** The compatibility shim: a symlink resolving to `target` (root-relative). */
  | { kind: "symlink"; target: string }
  /** Nothing may sit at the root under this name — it moved, or it never persists. */
  | { kind: "absent" }
  /**
   * Absent, or the plain FILE pre-move code keeps putting back — an
   * `unshimmable` row whose writer replaces the name. A symlink is a failure
   * here rather than a tolerated extra: it cannot survive the next pre-move
   * write, so leaving one planted would make the root's steady state depend on
   * which process wrote last.
   */
  | { kind: "absent-or-file" }
  /** The name IS a kind directory (`logs`); the kind rule below covers it. */
  | { kind: "kind-dir" };

export interface LegacyRootEntry {
  /** The top-level name under the data root. */
  name: string;
  /** The row that accounts for it. */
  move: LegacyMove["move"];
  /** Where the row sends it, for the check's failure message. `null` for a quarantine. */
  destination: string | null;
  expect: LegacyExpectation;
}

/**
 * Every top-level name the table accounts for, with the check's verification
 * rule for each. This is what replaces the hand-written `LEGACY_TOP_LEVEL` set:
 * the check's to-do list and the migration's plan are now literally the same
 * fact.
 */
export function legacyRootEntries(): LegacyRootEntry[] {
  const out: LegacyRootEntry[] = [];
  for (const row of LEGACY_LAYOUT) {
    for (const name of rowRootNames(row)) {
      if (row.move === "quarantine") {
        out.push({
          name,
          move: row.move,
          destination: `deprecated/${name}`,
          expect: { kind: "absent" },
        });
        continue;
      }
      if (row.move === "unshimmable") {
        out.push({
          name,
          move: row.move,
          destination: `${row.to}/${name}`,
          // The row's own `leaves` decides this, so the check cannot expect a
          // steady state the writer never produces.
          expect:
            row.leaves === "a file"
              ? { kind: "absent-or-file" }
              : { kind: "absent" },
        });
        continue;
      }
      const target = row.move === "file" ? `${row.to}/${name}` : row.to;
      out.push({
        name,
        move: row.move,
        destination: target,
        expect: rowIsShimmed(row)
          ? { kind: "symlink", target }
          : { kind: "kind-dir" },
      });
    }
  }
  return out;
}
// ── planMigration ────────────────────────────────────────────────────────────

/**
 * One filesystem fact the planner is handed. `path` is RELATIVE TO THE DATA ROOT
 * and `/`-separated; `children` are bare names, not paths.
 *
 * `symlink.target` MUST already be normalized to a root-relative path when the
 * link points inside the data root (the script does this), so the planner can
 * compare it against a `to` ref by string equality and never touches the
 * filesystem itself. A link pointing outside the root keeps its raw target,
 * which by construction never equals a `${kind}/${name}` ref — so it reads as
 * "some other link", which is exactly right.
 *
 * `children` is OPTIONAL and its absence means "not enumerated", never "empty".
 * The plan needs a directory's contents in only two places — is a destination
 * empty, and does the self-nesting source hold new-code strays — and the sources
 * it does NOT need include `closure-cache`, which has 190k entries. So the caller
 * enumerates where it matters and lstats everywhere else. Anything reading
 * `children` must treat `undefined` as "unknown", and unknown resolves to the
 * cautious answer (not empty, does not contain X).
 */
export type FsEntry =
  | { path: string; node: "dir"; children?: readonly DirChild[] }
  | { path: string; node: "file" }
  | { path: string; node: "symlink"; target: string };

/**
 * One entry of a directory listing. `file` means a PLAIN FILE — a directory, a
 * symlink and anything else are all `false`.
 *
 * The type is carried rather than just the name because the self-nesting check
 * turns on exactly this distinction: every legitimate child of the pre-migration
 * `logs/` is a plain file the gateway wrote, so anything else in there is
 * something else's, and the check needs to see that without a list of names.
 */
export interface DirChild {
  name: string;
  file: boolean;
}

export type MigrationMode = "apply" | "drop-legacy";

/**
 * What an operator does about a `blocked` step.
 *
 * - `discard-destination` — the named path is state NEW CODE wrote at a
 *   `<kind>/<name>` location before the migration ran. Nothing legitimately
 *   lives there beforehand, so it is a few minutes of re-derivable output
 *   standing in front of the real history, and deleting it (cluster down, after
 *   reading the numbers) is the resolution.
 * - `inspect` — anything else. No safe mechanical answer; a human looks.
 */
export type BlockedRemedy = "discard-destination" | "inspect";

/**
 * Exactly one action. The dry-run printer and the executor read the same list,
 * so a plan a human reviewed is the plan that runs.
 *
 * `row` is the `LEGACY_LAYOUT` row's `from`, so a printer can group steps by the
 * table entry that produced them.
 */
export type MigrationStep =
  /** `rename(from → to)`. `to` never exists; the parent is created recursively. */
  | { action: "rename"; row: string; from: string; to: string }
  /** Plant the compatibility shim: a symlink at `at` resolving to `target`. */
  | { action: "symlink"; row: string; at: string; target: string }
  /** `mkdir -p`. */
  | { action: "mkdir"; row: string; path: string }
  /** Move an owner-less entry into the quarantine. */
  | {
      action: "quarantine";
      row: string;
      from: string;
      to: string;
      reason: string;
    }
  /** Remove an entry (a shim, an empty destination, a stray). */
  | { action: "unlink"; row: string; path: string; reason: string }
  /**
   * **The whole run stops.** Not "skip this row and carry on" — a caller that
   * sees any `blocked` step must execute NOTHING and exit non-zero.
   *
   * There is deliberately no merge, and no "keep one side" rule. A collision at
   * a destination is always the same story — new code wrote a few minutes of
   * output at `<kind>/<name>` while the real history is still at the legacy path
   * — and any automatic resolution silently picks a winner. Picking the
   * destination stranded 7.8 MB of `op-log.jsonl` history behind a 3.4 KB file;
   * picking the source would clobber whatever the running system had just
   * written. Worse, a merge that left the legacy directory non-empty suppressed
   * its shim, so `cpu-slots` and `locks/cpu` would have become two disjoint flock
   * namespaces and the host CPU bound would have silently doubled.
   *
   * So the collision is not resolved here at all: it is reported with the numbers
   * an operator needs and handed to them.
   */
  | {
      action: "blocked";
      row: string;
      path: string;
      reason: string;
      remedy: BlockedRemedy;
    };

/**
 * `(filesystem facts, mode) → steps`. PURE — no `node:fs`, no `node:path`, no
 * clock. Both modes are idempotent by inspection: re-planning against the state
 * a plan produced yields an empty list.
 *
 * `entries` must cover, at minimum: every top-level entry under the data root
 * (each `from` and rotation sibling the table names, present or not), every
 * `${kind}/${name}` destination that exists, and every `deprecated/<from>` that
 * exists. A path absent from `entries` is read as absent from disk. Destinations
 * and the self-nesting source must carry `children`; see {@link FsEntry}.
 */
export function planMigration(
  entries: readonly FsEntry[],
  mode: MigrationMode,
): MigrationStep[] {
  const index = new Map<string, FsEntry>();
  for (const e of entries) index.set(e.path, e);
  const at = (path: string): FsEntry | undefined => index.get(path);

  // A path is occupied when it has its own entry OR when its parent directory
  // lists the name as a child. Both spellings must count: the parent's `children`
  // is how the caller reports a destination dir's contents, and requiring a
  // separate entry per child would make "the destination already holds this
  // name" depend on how thoroughly the caller walked the tree.
  const occupied = (path: string): boolean => {
    if (index.has(path)) return true;
    const cut = path.lastIndexOf("/");
    if (cut < 0) return false;
    const parent = index.get(path.slice(0, cut));
    if (parent?.node !== "dir") return false;
    const name = path.slice(cut + 1);
    return parent.children?.some((c) => c.name === name) ?? false;
  };

  const snap: Lookup = { at, occupied };
  const steps: MigrationStep[] = [];

  if (mode === "drop-legacy") {
    // Pass 2 ONLY ever deletes, so it must first establish that pass 1 has run.
    // Planned against an un-migrated root it misreads the original files as
    // strays and plans real unlinks of them — 7.8 MB of `op-log.jsonl` history
    // and 868 KB of `check-progress.jsonl` in the observed case. Nothing else
    // enforces the order between the passes, so a mistyped flag would be
    // unrecoverable. When the precondition fails, this is the WHOLE plan: the
    // per-row pass is skipped entirely, because every one of its verdicts is
    // about a state the root is not in.
    const notMigrated = preconditionViolations(snap);
    if (notMigrated.length > 0) return notMigrated;
  }

  for (const row of planningOrder()) {
    if (mode === "apply") planRowApply(row, snap, steps);
    else planRowDrop(row, snap, steps);
  }
  return steps;
}

/**
 * Must `a` be planned before `b`?
 *
 * Two rows can interact through the filesystem, and when they do the order is
 * forced. `LEGACY_LAYOUT` is a DECLARATION TABLE, so the order it happens to be
 * written in must not be able to decide whether a run works — a comment saying
 * "keep these two adjacent" reaches whoever reads it, and whoever adds row 65 in
 * a year will not.
 *
 * The two constraints, both derived from the row pair rather than declared:
 *
 * 1. **A directory that BECOMES `<kind>/<name>` lands before anything is placed
 *    inside it.** `secrets` renames onto `state/secrets`, and `secrets.json.enc`
 *    moves into that same directory. File-first would `mkdir state/secrets` and
 *    drop the blob in, and the directory row would then find a non-empty
 *    destination and stop the whole run.
 * 2. **A row whose SOURCE contains another row's destination goes first.** The
 *    `logs` row turns the legacy `logs/` into the `logs/` kind directory, and the
 *    log-file rows land in `logs/<name>` inside it. Running a file row first
 *    would `mkdir logs/op-log` while `logs/` is still the gateway's own
 *    directory — creating, by hand, exactly the contamination the self-nesting
 *    check refuses on.
 */
export function mustPrecede(a: LegacyMove, b: LegacyMove): boolean {
  if (a === b) return false;
  // An unshimmable row moves nothing, so nothing can depend on it.
  if (a.move === "unshimmable") return false;
  const bDest = b.move === "quarantine" ? `deprecated/${b.from}` : b.to;

  // (1) the directory that becomes the destination, before its contents
  if (a.move === "dir" && b.move === "file" && a.to === bDest) return true;
  // (2) the row that frees an ancestor path, before anything lands under it
  if (bDest === a.from || bDest.startsWith(`${a.from}/`)) return true;
  return false;
}

/**
 * `LEGACY_LAYOUT` topologically sorted by {@link mustPrecede}, stable in table
 * order among rows that do not constrain each other.
 *
 * This is what lets the table be an unordered SET of declarations: reordering it
 * by hand, or appending a new row anywhere, cannot change what a run does.
 * A cycle would mean two rows each need the other to have moved first, which is
 * a table that cannot be executed at all — so it throws rather than picking an
 * arbitrary order and half-working.
 */
export function planningOrder(): LegacyMove[] {
  const ordered: LegacyMove[] = [];
  const state = new Map<LegacyMove, "visiting" | "done">();

  const visit = (row: LegacyMove, trail: readonly string[]): void => {
    const seen = state.get(row);
    if (seen === "done") return;
    if (seen === "visiting")
      throw new Error(
        `[legacy-layout] rows constrain each other cyclically: ${[...trail, row.from].join(" → ")}`,
      );
    state.set(row, "visiting");
    for (const other of LEGACY_LAYOUT)
      if (mustPrecede(other, row)) visit(other, [...trail, row.from]);
    state.set(row, "done");
    ordered.push(row);
  };

  for (const row of LEGACY_LAYOUT) visit(row, []);
  return ordered;
}

/**
 * "Has pass 1 actually run here?", answered per row.
 *
 * A shimmed name must be either the compatibility symlink or gone. Anything
 * still sitting there as a real file or directory means the move never happened
 * for it.
 *
 * The one subtlety is a rotating family. `--drop-legacy` legitimately sweeps a
 * real file at a rotation slot — pre-move code rotating across the shim moves
 * the LINK and leaves the bytes at the root. But that is only a stray if a shim
 * exists to have been rotated across: with no shim anywhere in the family, a
 * real file there is simply the original, and sweeping it is the data loss this
 * function exists to prevent. So the family is judged as a unit.
 */
function preconditionViolations(snap: Lookup): MigrationStep[] {
  const out: MigrationStep[] = [];
  for (const row of LEGACY_LAYOUT) {
    if (!rowIsShimmed(row)) continue;

    const names = rowRootNames(row);
    const targetOf = (name: string): string =>
      row.move === "file" ? `${row.to}/${name}` : row.to;
    const isShim = (name: string): boolean => {
      const node = snap.at(name);
      return node?.node === "symlink" && node.target === targetOf(name);
    };
    if (names.some(isShim)) continue; // pass 1 ran for this row

    for (const name of names) {
      const node = snap.at(name);
      if (!node) continue; // absent: drained, or never existed here
      out.push(
        blocked(
          row.from,
          name,
          `is a real ${node.node === "dir" ? "directory" : node.node === "file" ? "file" : `symlink to ${node.target}`}, ` +
            `not the compatibility symlink → ${targetOf(name)}. Pass 1 has not run on this root, so this is the ` +
            "ORIGINAL entry, not a leftover — removing it would delete the only copy",
          "inspect",
        ),
      );
    }
  }
  return out;
}

/**
 * The pure counterpart of executing a plan: `(facts, steps) → facts`.
 *
 * Its reason for existing is the combined dry run. Pass 2 must be shown against
 * the state pass 1 LEAVES, not against the root as it is now — planned against
 * an un-migrated root it describes strays that are really originals and
 * quarantines that have not happened, which is worse than showing nothing. Since
 * `planMigration` is pure, simulating pass 1 in memory gives exactly the state
 * pass 2 will meet.
 *
 * The tests use it too, which is the point: the model the dry run predicts with
 * is the model the idempotency assertions are made against, so a divergence
 * between them is not expressible.
 *
 * Throws on an impossible step (renaming something absent) rather than papering
 * over it — that would mean the plan and the facts it was computed from disagree.
 */
export function simulateSteps(
  entries: readonly FsEntry[],
  steps: readonly MigrationStep[],
): FsEntry[] {
  const index = new Map<string, FsEntry>(entries.map((e) => [e.path, e]));
  const cut = (path: string): [string | null, string] => {
    const i = path.lastIndexOf("/");
    return i < 0 ? [null, path] : [path.slice(0, i), path.slice(i + 1)];
  };
  const linkChild = (path: string, add: FsEntry | null): void => {
    const [parent, name] = cut(path);
    if (parent === null) return;
    const node = index.get(parent);
    if (node?.node !== "dir" || node.children === undefined) return;
    const children = add
      ? node.children.some((c) => c.name === name)
        ? node.children
        : [...node.children, { name, file: add.node === "file" }]
      : node.children.filter((c) => c.name !== name);
    index.set(parent, { ...node, children });
  };
  const put = (entry: FsEntry): void => {
    index.set(entry.path, entry);
    linkChild(entry.path, entry);
  };
  const del = (path: string): void => {
    index.delete(path);
    linkChild(path, null);
  };
  const move = (from: string, to: string): void => {
    const node = index.get(from);
    if (!node)
      throw new Error(`[legacy-layout] simulate: cannot move absent ${from}`);
    del(from);
    put({ ...node, path: to });
  };

  for (const step of steps) {
    switch (step.action) {
      case "rename":
      case "quarantine":
        move(step.from, step.to);
        break;
      case "symlink":
        put({ path: step.at, node: "symlink", target: step.target });
        break;
      case "mkdir":
        if (!index.has(step.path))
          put({ path: step.path, node: "dir", children: [] });
        break;
      case "unlink":
        del(step.path);
        break;
      case "blocked":
        throw new Error(
          `[legacy-layout] simulate: a blocked plan is never executed (${step.path})`,
        );
    }
  }
  return [...index.values()];
}

interface Lookup {
  at: (path: string) => FsEntry | undefined;
  occupied: (path: string) => boolean;
}

function blocked(
  row: string,
  path: string,
  reason: string,
  remedy: BlockedRemedy,
): MigrationStep {
  return { action: "blocked", row, path, reason, remedy };
}

/**
 * Empty ONLY when the caller enumerated it and found nothing. An un-enumerated
 * directory answers "no" — the cautious side, since the consequence of a wrong
 * "yes" is deleting something.
 */
function isEmptyDir(entry: FsEntry): boolean {
  return entry.node === "dir" && entry.children?.length === 0;
}

/** The staging name a self-nesting row moves through: `logs` → `.logs-migrating`. */
export function stagingName(from: string): string {
  return `.${from}-migrating`;
}

const CONTAMINATED_DESTINATION =
  "exists and is not empty. Nothing legitimately lives at a <kind>/<name> path before this " +
  "migration, so this can only be output new code wrote against an un-migrated root — while the " +
  "real history is still at the legacy path. There is no correct automatic merge: either side " +
  "would be silently discarded";

function planRowApply(
  row: LegacyMove,
  snap: Lookup,
  out: MigrationStep[],
): void {
  switch (row.move) {
    // Never moved and never shimmed — old and new code simply write different
    // paths for one release cycle. Absent is "nothing to do", never an error.
    //
    // The one thing to plan is REMOVING a shim somebody planted here anyway: it
    // is a link, so nothing can be lost, and leaving it would let the root's
    // steady state depend on which process wrote last. A real file is pre-move
    // code's own output and stays until pass 2.
    case "unshimmable": {
      const src = snap.at(row.from);
      if (src?.node !== "symlink") return;
      out.push({
        action: "unlink",
        row: row.from,
        path: row.from,
        reason: `a shim no writer can keep — ${row.from} is replaced, not written through`,
      });
      return;
    }

    case "quarantine": {
      if (!snap.at(row.from)) return; // already quarantined, or never existed
      const to = `deprecated/${row.from}`;
      if (snap.occupied(to)) {
        out.push(
          blocked(
            row.from,
            to,
            "already exists — an earlier quarantine put something here under this name",
            "inspect",
          ),
        );
        return;
      }
      out.push({
        action: "quarantine",
        row: row.from,
        from: row.from,
        to,
        reason: row.reason,
      });
      return;
    }

    case "dir":
      planDirApply(row, snap, out);
      return;

    case "file":
      planFileApply(row, snap, out);
      return;
  }
}

function planDirApply(
  row: Extract<LegacyMove, { move: "dir" }>,
  snap: Lookup,
  out: MigrationStep[],
): void {
  const { from, to } = row;
  if (to.startsWith(`${from}/`)) {
    planSelfNestingApply(row, snap, out);
    return;
  }

  const src = snap.at(from);
  // Absent ⇒ pass 2 is done for this row (or the entry never existed here).
  if (!src) return;

  if (src.node === "symlink") {
    // Already a shim pointing at the declared target ⇒ pass 1 is done.
    if (src.target === to) return;
    out.push(
      blocked(
        from,
        from,
        `is a symlink to ${src.target}, not to ${to}`,
        "inspect",
      ),
    );
    return;
  }
  if (src.node !== "dir") {
    out.push(
      blocked(
        from,
        from,
        "is a file; the table says it is a directory",
        "inspect",
      ),
    );
    return;
  }

  const dst = snap.at(to);
  if (dst) {
    if (dst.node !== "dir") {
      out.push(blocked(from, to, "exists and is not a directory", "inspect"));
      return;
    }
    if (!isEmptyDir(dst)) {
      out.push(
        blocked(from, to, CONTAMINATED_DESTINATION, "discard-destination"),
      );
      return;
    }
    // Empty: new code created the directory and never wrote to it, so there is
    // nothing to lose and nothing to decide. Remove it so the rename can land.
    out.push({
      action: "unlink",
      row: from,
      path: to,
      reason:
        "the empty destination new code created, so the rename can take its place",
    });
  }

  out.push({ action: "rename", row: from, from, to });
  if (rowIsShimmed(row))
    out.push({ action: "symlink", row: from, at: from, target: to });
}

/**
 * `logs/` nests into itself, so it cannot be one rename:
 * `rename(logs, .logs-migrating)` → `mkdir logs` → `rename(.logs-migrating,
 * logs/gateway)`. Resumable — a staging dir present on entry means continue from
 * step 2.
 *
 * The dance assumes root `logs/` holds ONLY the gateway's files. New code
 * running against an un-migrated root breaks that assumption from the inside: it
 * creates its own `logs/op-log/`, `logs/check-progress/` and
 * `logs/signal-origin/` in there, and the dance would carry them down to
 * `logs/gateway/op-log/` and so on. So the strays are looked for FIRST, and any
 * one of them stops the run — the ordinary destination test cannot see them,
 * because their destination is a level below the entry being renamed.
 *
 * "Already done" is `logs/gateway` existing. That cannot distinguish a completed
 * dance from a `logs/` that acquired a `gateway/` child some other way; nothing
 * in the codebase creates one except the gateway-logs declaration's own
 * `ensure()`, which is the correct post-migration state anyway.
 */
function planSelfNestingApply(
  row: Extract<LegacyMove, { move: "dir" }>,
  snap: Lookup,
  out: MigrationStep[],
): void {
  const { from, to } = row;
  const staging = stagingName(from);
  const staged = snap.at(staging);

  if (staged) {
    if (staged.node !== "dir") {
      out.push(blocked(from, staging, "is not a directory", "inspect"));
      return;
    }
    const dst = snap.at(to);
    if (dst) {
      if (dst.node !== "dir") {
        out.push(blocked(from, to, "exists and is not a directory", "inspect"));
        return;
      }
      if (!isEmptyDir(dst)) {
        out.push(
          blocked(from, to, CONTAMINATED_DESTINATION, "discard-destination"),
        );
        return;
      }
      out.push({
        action: "unlink",
        row: from,
        path: to,
        reason:
          "the empty destination new code created, so the rename can take its place",
      });
    } else if (!snap.at(from)) {
      out.push({ action: "mkdir", row: from, path: from });
    }
    out.push({ action: "rename", row: from, from: staging, to });
    return;
  }

  if (snap.occupied(to)) return; // the dance completed on an earlier run

  const src = snap.at(from);
  if (!src) return;
  if (src.node !== "dir") {
    out.push(blocked(from, from, "is not a directory", "inspect"));
    return;
  }

  // EVERY legitimate child of the pre-migration `logs/` is a plain FILE: the
  // gateway writes `<worktree>.log` and its rotations there and nothing else.
  // So anything that is not a plain file was put there by something else — new
  // code creating its own `logs/<name>` sink directory on an un-migrated root —
  // and the dance would carry it down to `logs/gateway/<name>` where nothing
  // would ever read it again.
  //
  // Stated as the invariant rather than as a list of known names, which is what
  // makes it catch the ones nobody can enumerate: on the live root it flags
  // `fd-monitor-incidents`, written by a launchd script that has no legacy row
  // and would not have been on any derived list.
  const strays = (src.children ?? []).filter((c) => !c.file);
  if (strays.length > 0) {
    for (const stray of strays)
      out.push(
        blocked(
          from,
          `${from}/${stray.name}`,
          `is not a plain file, and every legitimate child of the legacy ${from} directory is one. ` +
            `Something other than the gateway put it there — the staging dance would carry it down ` +
            `to ${to}/${stray.name}, where nothing would ever read it again`,
          "discard-destination",
        ),
      );
    return;
  }

  out.push({ action: "rename", row: from, from, to: staging });
  out.push({ action: "mkdir", row: from, path: from });
  out.push({ action: "rename", row: from, from: staging, to });
  // No shim: `from` is a kind name, so the root entry must BE the kind dir.
}

function planFileApply(
  row: Extract<LegacyMove, { move: "file" }>,
  snap: Lookup,
  out: MigrationStep[],
): void {
  const { from, to } = row;
  let destDirPlanned = snap.occupied(to);

  // Did pass 1 run for THIS row? The two causes of a real file at the root look
  // identical on disk, and everything below turns on telling them apart:
  //
  //   not shimmed ⇒ the root file is the ORIGINAL and the destination beside it
  //                 is new code's output. No safe merge; `blocked` keeps its
  //                 numbers and its remedy.
  //   shimmed     ⇒ the move ran and planted shims, so anything real at the root
  //                 now is what a pre-move writer put BACK — see the
  //                 `unshimmable` arm: an atomic rename onto the shim, or a
  //                 rotation of it, replaces the link instead of writing through
  //                 it. Both sides hold real bytes, so the stray is rescued.
  //
  // The evidence is a symlink at ANY slot pointing INTO this family's
  // destination: only pass 1 creates one, and nothing on an un-migrated root
  // does. Judged as a FAMILY, the same unit `preconditionViolations` uses — and
  // deliberately not "this slot's own shim", because a rotation shuffles every
  // slot's link one place along, so after one there is no slot left holding its
  // own target. A `keep: 0` row has a single slot, so a clobber there leaves no
  // evidence at all and falls to `blocked` — the cautious side, since the only
  // other reading is that the file is the original.
  const familyTargets = new Set(rowRootNames(row).map((n) => `${to}/${n}`));
  const shimmed = rowRootNames(row).some((n) => {
    const node = snap.at(n);
    return node?.node === "symlink" && familyTargets.has(node.target);
  });
  const rescued = new Set<string>();

  for (const name of rowRootNames(row)) {
    const src = snap.at(name);
    // Absent ⇒ this rotation slot was never written, or pass 2 already ran.
    if (!src) continue;

    const dest = `${to}/${name}`;
    if (src.node === "symlink") {
      if (src.target === dest) continue; // already shimmed
      // A shim ROTATED ACROSS: pre-move code renamed `x` to `x.1`, which moves
      // the LINK and not the bytes, so a shim now sits one slot along still
      // pointing at another member of its own family. Removing a link loses
      // nothing, and this slot's own shim goes back in its place.
      if (familyTargets.has(src.target)) {
        out.push({
          action: "unlink",
          row: from,
          path: name,
          reason: `a shim rotated across by pre-move code — it points at ${src.target}, not ${dest}`,
        });
        out.push({ action: "symlink", row: from, at: name, target: dest });
        continue;
      }
      out.push(
        blocked(
          from,
          name,
          `is a symlink to ${src.target}, not to ${dest}`,
          "inspect",
        ),
      );
      continue;
    }
    if (src.node === "dir") {
      out.push(
        blocked(
          from,
          name,
          "is a directory; the table says it is a file",
          "inspect",
        ),
      );
      continue;
    }
    if (snap.occupied(dest)) {
      if (!shimmed) {
        out.push(
          blocked(from, dest, CONTAMINATED_DESTINATION, "discard-destination"),
        );
        continue;
      }
      // RESCUE, then re-plant. The destination holds the history and the root
      // holds what pre-move code has written since it replaced the shim, so
      // neither may be dropped and there is no merge that could be right. The
      // stray moves in beside its own family under a name that says where it
      // came from, and the shim is planted again — bounded, lossless, and
      // repeatable: a second clobber rescues to `.pre-move-2`.
      let at = `${dest}.pre-move-1`;
      for (let n = 2; snap.occupied(at) || rescued.has(at); n++)
        at = `${dest}.pre-move-${n}`;
      rescued.add(at);
      out.push({ action: "rename", row: from, from: name, to: at });
      out.push({ action: "symlink", row: from, at: name, target: dest });
      continue;
    }
    if (!destDirPlanned) {
      out.push({ action: "mkdir", row: from, path: to });
      destDirPlanned = true;
    }
    out.push({ action: "rename", row: from, from: name, to: dest });
    out.push({ action: "symlink", row: from, at: name, target: dest });
  }
}

function planRowDrop(
  row: LegacyMove,
  snap: Lookup,
  out: MigrationStep[],
): void {
  switch (row.move) {
    case "quarantine": {
      if (!snap.at(row.from)) return;
      out.push(
        blocked(
          row.from,
          row.from,
          "was quarantined, but the name is back at the root — something recreated it",
          "inspect",
        ),
      );
      return;
    }

    case "unshimmable": {
      const src = snap.at(row.from);
      if (!src) return;
      if (src.node === "dir") {
        out.push(
          blocked(
            row.from,
            row.from,
            "is a directory; the table says it is a file",
            "inspect",
          ),
        );
        return;
      }
      out.push({
        action: "unlink",
        row: row.from,
        path: row.from,
        reason: `stale file left by pre-move code; the live one is ${row.to}/${row.from}`,
      });
      return;
    }

    case "dir": {
      // `logs` IS the kind directory after the move — never a shim, so there is
      // nothing here to drop and its being a real directory is correct.
      if (!rowIsShimmed(row)) return;
      const src = snap.at(row.from);
      if (!src) return; // pass 2 already ran
      if (src.node === "symlink") {
        out.push({
          action: "unlink",
          row: row.from,
          path: row.from,
          reason: `compatibility shim → ${src.target}`,
        });
        return;
      }
      out.push(
        blocked(
          row.from,
          row.from,
          `is a real ${src.node === "dir" ? "directory" : "file"}, not the compatibility symlink — ` +
            "something wrote to the old path as a fresh entry, and deleting it blind would be data loss",
          "inspect",
        ),
      );
      return;
    }

    case "file": {
      for (const name of rowRootNames(row)) {
        const src = snap.at(name);
        if (!src) continue;
        if (src.node === "symlink") {
          out.push({
            action: "unlink",
            row: row.from,
            path: name,
            reason: `compatibility shim → ${src.target}`,
          });
          continue;
        }
        if (src.node === "file") {
          out.push({
            action: "unlink",
            row: row.from,
            path: name,
            reason:
              "stray left by a rotation across the shim (pre-move code rotated the live file, so the link moved instead of the bytes)",
          });
          continue;
        }
        out.push(
          blocked(
            row.from,
            name,
            "is a real directory, not the compatibility symlink — deleting it blind would be data loss",
            "inspect",
          ),
        );
      }
      return;
    }
  }
}
