import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  Check,
  CheckContext,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { loadCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";
import { grepCode } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
// Own-plugin, so relative — the `@plugins/infra/plugins/paths/core` alias would
// name this plugin from inside itself. Same shape as `test-layout/check`
// importing `../core/test-layout`.
import { checkoutWorktreeName } from "../core/internal/paths";
import { dataDirsEntries } from "../core/data-dirs.generated";
import {
  DATA_DIR_KINDS,
  dataRoot,
  getDataDirs,
  isDataDir,
  moveDestination,
} from "../core/internal/data-dir";
import type { DataDir } from "../core/internal/data-dir";
import {
  DECLARATION_CALL_PATTERN,
  evaluateDataDirDeclarations,
  evaluateDeclarationCallSites,
} from "../core/internal/app-data-dirs";
import type { DataDirDeclaration } from "../core/internal/app-data-dirs";
import {
  declaredSets,
  describeAttribution,
  manifestStamps,
  partitionByOwner,
  readForeignManifests,
} from "../core/internal/data-dirs-manifest";
import { legacyRootEntries } from "../core/internal/legacy-layout";
import type { LegacyRootEntry } from "../core/internal/legacy-layout";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Strings are split so this source file does not match its own grep patterns.
const PATTERNS = [
  "home" + "dir()",
  "process.env" + ".HOME",
  "/opt/" + "homebrew",
  "/usr/" + "bin/",
  "/" + "Users/",
  "~/" + ".singularity",
];

const noHardcodedPathsCheck: Check = {
  id: "paths:no-hardcoded-paths",
  description:
    "Filesystem paths must come from @plugins/infra/plugins/paths/{core,server}; no homedir() calls or hardcoded path strings in TS",
  exemptable: {
    "paths:no-hardcoded-paths":
      "calls homedir() or spells a hardcoded path string instead of importing it from the paths plugin",
  },
  outOfScope: ["research"],
  async run(ctx) {
    const root = await getWorktreeRoot();
    const exempt = await ctx.exempt("paths:no-hardcoded-paths");
    const seen = new Set<string>();
    const offenders: string[] = [];

    for (const pattern of PATTERNS) {
      const matches = await grepCode({
        root,
        pattern: new RegExp(escapeRegExp(pattern)),
        grepArg: pattern,
        fixed: true,
        maskStrings: false,
      });

      for (const m of matches) {
        const line = `${m.path}:${m.line}:${m.text}`;
        if (seen.has(line)) continue;
        seen.add(line);

        if (exempt.skips(m.path)) continue;

        offenders.push(line);
      }
    }

    if (offenders.length === 0) return { ok: true };

    return {
      ok: false,
      message: `hardcoded path found in ${offenders.length} place(s):\n    ${offenders.join("\n    ")}`,
      hint: "Import path constants from `@plugins/infra/plugins/paths/core` (e.g. HOME_DIR, REPO_ROOT) or `@plugins/infra/plugins/paths/server` (e.g. GIT, TMUX, resolveClaudeBin) instead of constructing paths from homedir() or hardcoding binary paths. For anything under the singularity data root, declare it with `defineDataDir` — or, for an app's content, use an area of that app's one data dir (`defineAppDataDir` at the app's root, `.subdir(…)` from sub-plugins) — there is no root constant to join.",
    };
  },
};

// Guards the per-worktree FILE layout owned by paths.ts: the `worktrees/<name>`
// data dir (worktreeDataDir), the namespace's registration record
// (WORKTREE_SPEC_FILE) and the build artifact filenames (worktreeArtifacts). Re-inlining any of these re-couples a reader to a writer
// behind paths.ts's back, exactly the drift the single source of truth exists
// to prevent.
//
// This is DISTINCT from the git-checkout `.claude/worktrees` path (see
// plugins/infra/plugins/worktree): that is a different concept and is
// intentionally NOT matched here — pattern 1 is scoped to data-root-derived
// paths, so `join(repoRoot, ".claude", "worktrees")` never trips this check and
// needs no allowlist entry.
const WORKTREE_ARTIFACT_PATTERNS: { pattern: RegExp; grepArg: string }[] = [
  // Base dir re-inline: join(dataRoot(), "worktrees" or `${dataRoot()}/worktrees`.
  // `paths:data-root-not-joined` also refuses any join of the root; this keeps
  // the specific diagnostic, which names `worktreeDataDir` as the replacement.
  {
    pattern: /dataRoot\s*\(\s*\)\s*(?:,\s*["'`]|\}?\/)worktrees/,
    grepArg: "worktrees",
  },
  // build-profile artifact filename.
  { pattern: /["'`]build-profile[^"'`\s]*\.json/, grepArg: "build-profile" },
  // build-logs artifact filename.
  { pattern: /["'`]build-logs[^"'`\s]*\.json/, grepArg: "build-logs" },
  // build.log human-readable artifact filename.
  { pattern: /["'`]build(?:-[^"'`\s]*)?\.log/, grepArg: ".log" },
  // spec.json — the namespace's registration record. Its absence here is what
  // let the backend's own boot reader compute the path from its parts, a second
  // TypeScript spelling of the file its writer publishes; the filename is
  // `WORKTREE_SPEC_FILE` in the core. The leading quote class keeps unrelated
  // `*.spec.json` files out (the release command's `appdmg.spec.json`), and the
  // Go gateway — a third reader, in a language that cannot import the core — is
  // out of this check's reach by construction: it only scans TS.
  { pattern: /["'`]spec\.json/, grepArg: "spec.json" },
  // check.log check-transcript filename. Its absence here is what let four
  // separate `join(worktreeDataDir(name), "check.log")` call sites be written by
  // hand — and stay in sync with each other but not with the artifact layout.
  { pattern: /["'`]check(?:-[^"'`\s]*)?\.log/, grepArg: ".log" },
  // The namespace's declared-data-dir manifest. Read by an audit running in a
  // DIFFERENT checkout, so a second spelling of the filename would put reader
  // and writer in different worktrees — the one place a rename could not be
  // caught by following imports.
  { pattern: /["'`]data-dirs\.json/, grepArg: "data-dirs.json" },
  // The supervised-run artifact dir. Every other entry above names a FILE,
  // because every other family is a flat file in the data dir and re-inlining
  // one means typing its name. This family is a subdirectory, so the way back
  // in is joining the dir rather than spelling a filename — and once you hold
  // the dir, `runTranscript` / `runTerminal` are trivially reconstructable.
  // Hence the pattern is on the join, with `worktreeDataDir` as the fixed
  // prefilter (a bare "runs" would scan half the repo).
  {
    pattern: /worktreeDataDir\s*\([^)]*\)\s*,\s*["'`]runs["'`]/,
    grepArg: "worktreeDataDir",
  },
  // The supervised-run exit marker. A distinctive extension precisely so this
  // pattern can exist: a plain `.exit` would collide with every `process.exit`
  // written inside a template literal or a docblock's backticks.
  { pattern: /["'`][^"'`\s]*\.exit-code/, grepArg: ".exit-code" },
];

// The paths plugin OWNS the artifact layout: paths.ts defines it, the prune
// logic (core/internal/prune-artifacts.ts) mirrors the filename families
// to reap old artifacts, and both have co-located tests that reference concrete
// filenames. Anything inside the plugin is source-of-truth territory (its own
// manifest exempts the whole plugin). This guard exists to stop *other*
// plugins from re-coupling to the layout behind paths.ts's back — not to police
// the owner's own internals.
const noInlinedWorktreeArtifactsCheck: Check = {
  id: "paths:no-inlined-worktree-artifacts",
  description:
    "The per-worktree file layout (the worktrees/<name> data dir, the namespace's spec.json, and the build/release artifact filenames) must come from worktreeDataDir()/worktreeArtifacts/WORKTREE_SPEC_FILE in @plugins/infra/plugins/paths; never re-inline the base dir or a raw filename.",
  exemptable: {
    "paths:no-inlined-worktree-artifacts":
      "re-inlines the per-worktree file layout (the worktrees/<name> dir or a raw artifact filename) instead of deriving it from the paths plugin",
  },
  outOfScope: ["research"],
  async run(ctx) {
    const root = await getWorktreeRoot();
    const exempt = await ctx.exempt("paths:no-inlined-worktree-artifacts");
    const seen = new Set<string>();
    const offenders: string[] = [];

    for (const p of WORKTREE_ARTIFACT_PATTERNS) {
      const matches = await grepCode({
        root,
        pattern: p.pattern,
        grepArg: p.grepArg,
        fixed: true,
        maskStrings: false,
      });

      for (const m of matches) {
        const line = `${m.path}:${m.line}:${m.text}`;
        if (seen.has(line)) continue;
        seen.add(line);

        if (exempt.skips(m.path)) continue;

        offenders.push(line);
      }
    }

    if (offenders.length === 0) return { ok: true };

    return {
      ok: false,
      message: `inlined worktree-artifact path found in ${offenders.length} place(s):\n    ${offenders.join("\n    ")}`,
      hint: "Import `worktreeDataDir` / `worktreeArtifacts` / `WORKTREE_SPEC_FILE` from `@plugins/infra/plugins/paths/core` (or `/server`) instead of reconstructing the ~/.singularity/worktrees/<name> dir or hardcoding a per-worktree filename (spec.json, build-profile*.json, build-logs*.json, build*.log, check*.log). Note: the git-checkout `.claude/worktrees` path (plugins/infra/plugins/worktree) is a different concept and intentionally out of scope.",
    };
  },
};

// ── no-undeclared-data-dirs ─────────────────────────────────────────────────
//
// The check that reads the data root AS A WHOLE. Nothing ever did, which is why
// `~/.singularity/` accreted 60-odd top-level entries — nine of them orphans
// with zero references left in the repo, ~1 GB, discovered a year late by a
// hand audit rather than by anything that runs.
//
// The two checks above are grep checks over the tree: they police how the repo
// SPELLS a path. This one polices the filesystem the repo WRITES TO, which is
// state no tree scan can see. Hence `scope: "deploy"` — the verdict is not a
// function of the working-tree hash, so it owes a `cacheSignature()` (asserted
// at load in `checks/core/runner.ts`) that folds in everything it reads.
//
// Three rules, in one pass over one observation of the root:
//
//   1. **Top level.** Every entry is one of the closed set of KINDS, a
//      permanently-grandfathered live service (a declaration carrying a
//      `legacyLocation`), OS noise, or a name `LEGACY_LAYOUT` accounts for.
//   2. **The legacy names are VERIFIED, not tolerated.** There is no
//      hand-written allowlist any more: the grandfathered set is derived from
//      `LEGACY_LAYOUT` (`core/internal/legacy-layout.ts`) — the same table the
//      one-off migrate script executes, so the to-do list and the migration plan
//      are literally the same fact and cannot drift. A legacy name passes only
//      if it is what its own row says it must be: the compatibility SYMLINK
//      resolving to its declared target; absent (for a quarantined row, for an
//      `unshimmable` row whose writer unlinks, and for any row whose shim the
//      drop-legacy pass has already removed); or the plain FILE pre-move code
//      keeps putting back, for an `unshimmable` row whose writer replaces the
//      name and where no shim can therefore hold. A legacy name still sitting
//      there as a real directory is a FAILURE — the old allowlist would have
//      stayed green through exactly that, which is how a "shrinking to-do list"
//      can shrink to nothing on paper while nothing has moved on disk.
//   3. **Second level.** Every entry inside a kind directory is itself a
//      declared `${kind}/${name}`. Without this the check goes vacuous the
//      moment the top level is seven kind dirs: `state` is a kind, so a
//      hand-made `state/foo` would pass rule 1 forever.
//
//      The one other thing that may sit there is a declared MOVE's old location
//      (`movedFrom.from` on some declaration — see `MovedFrom` in
//      `core/internal/data-dir.ts`), verified the way rule 2 verifies a legacy
//      name: the symlink the move planted, resolving to its destination; or,
//      while the move is pending (main has not booted on the merged code yet),
//      the real directory with its destination still absent. A real directory
//      with its destination ALSO present is a split copy and fails. This runs
//      before the foreign-manifest attribution, so a move's own old name is
//      judged by the move rather than excused by some older checkout that still
//      declares it.
//
// "DECLARED" MEANS DECLARED ON THIS MACHINE, not declared in this checkout.
// Rules 1 and 3 both read the union of this checkout's registry and every other
// live namespace's published manifest (`core/internal/data-dirs-manifest.ts`).
// The root is host-global — it holds the union of every branch that has ever run
// here — while a checkout's registry is one branch's view, and comparing those
// two directly is a category error: it reported `state/agent-write-ledger`, a
// directory a concurrently-running agent's correct-but-unmerged branch had just
// created, as an orphan, and failed the deploy of a worktree that could neither
// delete it nor declare it. An entry another live namespace owns is now logged
// as owned. What reaches the offender list is an entry NOBODY on this machine
// declares, which is the orphan this check has always been about.
//
// Rules 2 and 3's second half are self-liquidating: when every legacy name has
// drained, `LEGACY_LAYOUT`, the migrate script and rule 2 are deleted together.

/**
 * Entries the OS mints that no plugin will ever own and nobody may declare.
 * Kept separate from the legacy table deliberately: that table is a to-do that
 * liquidates itself, this set is permanent, and merging them would make the
 * to-do list look like it can never reach zero.
 */
const OS_NOISE = new Set([".DS_Store"]);

const KIND_NAMES: ReadonlySet<string> = new Set<string>(DATA_DIR_KINDS);

/**
 * Kinds whose CONTENTS are not a declared set, exempt from the second-level rule.
 *
 * - `deprecated` IS the quarantine: its entries are precisely the things with no
 *   owner, so demanding a declaration for each would invert the point of it.
 * - `worktrees` is per-worktree and dynamic — one entry per live namespace,
 *   minted and reaped at runtime. Its layout is owned by `paths.ts`
 *   (`worktreeDataDir` / `worktreeArtifacts`) and policed by
 *   `paths:no-inlined-worktree-artifacts` above, not by a registry of names.
 */
const OPEN_KINDS: ReadonlySet<string> = new Set(["deprecated", "worktrees"]);

/** What actually sits at a path — never a boolean, so "absent" and "wrong shape" stay distinct. */
type RootNode =
  | { node: "absent" }
  /** A symlink, with its target already resolved to a ROOT-RELATIVE `/`-path. */
  | { node: "symlink"; target: string }
  | { node: "dir" }
  | { node: "file" };

const ABSENT: RootNode = { node: "absent" };

/**
 * What sits at `name` — a root-relative `/`-path, top-level (`attachments`) or
 * deeper (`apps/wallpaper`). A symlink's relative target is resolved against the
 * LINK'S OWN directory, which is how the kernel reads it: `apps/wallpaper →
 * desktop/wallpaper` means `apps/desktop/wallpaper`, not `desktop/wallpaper`. For
 * a top-level name that directory is the root itself, so the legacy shims read
 * exactly as they always did.
 */
function inspect(root: string, name: string): RootNode {
  const full = join(root, name);
  const st = lstatSync(full, { throwIfNoEntry: false });
  if (!st) return ABSENT;
  if (st.isSymbolicLink()) {
    const raw = readlinkSync(full);
    const abs = isAbsolute(raw) ? raw : resolve(dirname(full), raw);
    return {
      node: "symlink",
      target: relative(root, abs).split(sep).join("/"),
    };
  }
  return st.isDirectory() ? { node: "dir" } : { node: "file" };
}

/**
 * A listing, or `null` when the directory does not exist — a fresh machine that
 * has never run a build. Nothing to police in that case; an unreadable-for-any-
 * other-reason path is a real fault and rethrows.
 */
function readEntries(path: string): string[] | null {
  try {
    return readdirSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Everything the verdict is a function of, read ONCE.
 *
 * `cacheSignature()` and `run()` both consume this, so the signature cannot
 * cover less than the verdict does — which is the failure mode a deploy-scoped
 * check has: a cached PASS that outlives the state it was about.
 */
interface RootObservation {
  root: string;
  /** Top-level listing, or `null` when the root does not exist yet. */
  entries: string[] | null;
  /** kind → its listing. Kinds with no directory on disk are absent from the map. */
  kinds: Map<string, string[]>;
  /**
   * `${kind}/${child}` → what that entry IS, for every listed kind child. A
   * listing says a name exists; a declared move's verdict turns on whether that
   * name is a symlink (settled) or a real directory (pending, or a split copy),
   * so the node itself is part of what the verdict reads.
   */
  kindNodes: Map<string, RootNode>;
  /**
   * For every kind child that is a symlink: what sits at its target. A settled
   * move passes only while its shim resolves to the destination, so the target
   * vanishing is a change the signature must see.
   */
  linkTargets: Map<string, RootNode>;
  /** Every legacy name the table accounts for → what actually sits there. */
  legacy: Map<string, RootNode>;
  /**
   * Kind names that are ALSO an un-migrated legacy directory → where that
   * directory is going.
   *
   * `logs` is both a kind and the gateway's own log directory, and until the
   * migration runs the second meaning is the true one. Its 1500 children are not
   * undeclared kind-children somebody minted; they are gateway logs sitting
   * where they have always sat, and they move wholesale into `logs/gateway/`.
   * Enumerating them would produce 1500 near-identical lines all saying the
   * same thing, and saying it wrongly.
   */
  unmigratedKinds: Map<string, string>;
}

function observeRoot(): RootObservation {
  const root = dataRoot();
  const entries = readEntries(root);
  const kinds = new Map<string, string[]>();
  const kindNodes = new Map<string, RootNode>();
  const linkTargets = new Map<string, RootNode>();
  const legacy = new Map<string, RootNode>();
  const unmigratedKinds = new Map<string, string>();
  if (entries === null)
    return {
      root,
      entries,
      kinds,
      kindNodes,
      linkTargets,
      legacy,
      unmigratedKinds,
    };

  for (const kind of DATA_DIR_KINDS) {
    if (OPEN_KINDS.has(kind)) continue;
    const children = readEntries(join(root, kind));
    if (children === null) continue;
    kinds.set(kind, children);
    for (const child of children) {
      const key = `${kind}/${child}`;
      const node = inspect(root, key);
      kindNodes.set(key, node);
      if (node.node === "symlink")
        linkTargets.set(key, inspect(root, node.target));
    }
  }
  for (const entry of legacyRootEntries()) {
    legacy.set(entry.name, inspect(root, entry.name));
    // A `kind-dir` row is a legacy directory whose name IS a kind. Its move has
    // happened once its destination exists — the same signal the migration's own
    // "already done" test uses.
    if (entry.expect.kind !== "kind-dir" || entry.destination === null)
      continue;
    if (inspect(root, entry.destination).node !== "dir")
      unmigratedKinds.set(entry.name, entry.destination);
  }
  return {
    root,
    entries,
    kinds,
    kindNodes,
    linkTargets,
    legacy,
    unmigratedKinds,
  };
}

const SAMPLE_CAP = 10;

/** A few names, then a count — a listing a person reads rather than scrolls. */
function sample(names: readonly string[]): string {
  const shown = [...names].sort().slice(0, SAMPLE_CAP);
  const rest = names.length - shown.length;
  return rest > 0
    ? `${shown.join(", ")}, … and ${rest} more`
    : shown.join(", ");
}

function describe(node: RootNode): string {
  switch (node.node) {
    case "absent":
      return "absent";
    case "symlink":
      return `a symlink → ${node.target}`;
    case "dir":
      return "a real directory";
    case "file":
      return "a real file";
  }
}

/** The repair command, spelled once — three messages below hand it to a person. */
const MIGRATE =
  "bun plugins/infra/plugins/paths/scripts/migrate-data-layout.ts";

/**
 * Verify ONE grandfathered legacy name against what the table says must be there.
 *
 * This is the whole difference between the old hand-written allowlist and this
 * one. The allowlist said "tolerate this name"; the table says "tolerate this
 * name IF it is the compatibility shim pointing at its declared target". A
 * legacy directory that never moved, or a shim pointing somewhere else, is a
 * failure — so the grandfathering can no longer hide the migration not having
 * happened.
 */
function verifyLegacy(entry: LegacyRootEntry, node: RootNode): string | null {
  switch (entry.expect.kind) {
    // The name IS one of the kinds; the second-level rule below owns it.
    case "kind-dir":
      return null;
    case "absent":
      if (node.node === "absent") return null;
      return (
        `${entry.name} is ${describe(node)}; a "${entry.move}" row must leave nothing at the root ` +
        `(it belongs at ${entry.destination ?? "deprecated/"})`
      );
    // No shim can hold here, because pre-move code REPLACES this name rather
    // than writing through it. The file it keeps putting back is the expected
    // steady state, not a fault — but a shim is: it cannot survive the next such
    // write, so tolerating one would make the root's state depend on which
    // process wrote last.
    case "absent-or-file": {
      if (node.node === "absent" || node.node === "file") return null;
      if (node.node === "symlink")
        return (
          `${entry.name} is ${describe(node)}; no shim can hold at this name — pre-move code ` +
          `replaces it rather than writing through it — so none may be planted here ` +
          `(the live file is ${entry.destination}). \`${MIGRATE} --apply\` removes it.`
        );
      return (
        `${entry.name} is ${describe(node)}; the table says it is a file ` +
        `(the live one is ${entry.destination})`
      );
    }
    case "symlink": {
      // Absent means the drop-legacy pass already ran for this row (or the entry
      // never existed on this machine) — fully drained, nothing to police.
      if (node.node === "absent") return null;
      if (node.node === "symlink" && node.target === entry.expect.target)
        return null;
      // Two readings, one repair. Either the migration never ran here and this
      // is the original, or it ran and a pre-move writer REPLACED the shim it
      // planted — an atomic `rename(tmp, name)`, or a rotation that moved the
      // link one slot along. `--apply` covers both: it moves an original, and
      // it rescues a stray beside its family before re-planting the shim.
      return (
        `${entry.name} is ${describe(node)}; after the layout migration it must be the compatibility ` +
        `symlink → ${entry.expect.target}. Either the migration has not run on this root, or a ` +
        `pre-move writer replaced the shim (an atomic rename, or a log rotation, writes the NAME ` +
        `rather than the bytes behind it). \`${MIGRATE}\` (dry run), then \`--apply\`, covers both: ` +
        `it moves an original, and it rescues a stray beside its family before re-planting the shim. ` +
        `Where the two are indistinguishable it stops and shows you the sizes instead of guessing.`
      );
    }
  }
}

/** A declared move's old location, as rule 3 needs it. */
interface DeclaredMove {
  /** Root-relative destination — the new dir, or its area. */
  destination: string;
  /** The declaration that records the move. */
  declaredBy: string;
}

/** Every `movedFrom.from` this checkout declares → where it went and who says so. */
function declaredMoves(
  declared: ReadonlyMap<string, DataDir>,
): Map<string, DeclaredMove> {
  const out = new Map<string, DeclaredMove>();
  for (const [key, dir] of declared)
    for (const move of dir.spec.movedFrom ?? [])
      out.set(move.from, {
        destination: moveDestination(dir.spec, move),
        declaredBy: key,
      });
  return out;
}

type MoveVerdict =
  | { kind: "settled" }
  | { kind: "pending" }
  | { kind: "problem"; message: string };

/**
 * Verify one declared move's OLD location — the rule-3 twin of
 * {@link verifyLegacy}, and it mirrors what the resolution in `data-dir.ts`
 * does with the same two facts, so the audit and the mover cannot disagree
 * about which state a root is in.
 */
function verifyMove(
  from: string,
  node: RootNode,
  move: DeclaredMove,
  destination: RootNode,
): MoveVerdict {
  switch (node.node) {
    case "absent":
      return { kind: "settled" };
    case "symlink":
      if (node.target === move.destination) return { kind: "settled" };
      return {
        kind: "problem",
        message:
          `${from} is ${describe(node)}, but ${move.declaredBy} records that it moved to ${move.destination} — ` +
          `the shim at the old location must point there, or older checkouts write somewhere nobody reads.`,
      };
    case "dir":
      if (destination.node === "absent") return { kind: "pending" };
      return {
        kind: "problem",
        message:
          `${from} and ${move.destination} are both present (${move.declaredBy} records that the first moved to the ` +
          `second) — a SPLIT COPY. Every read of ${move.declaredBy} throws until a human merges them: move whatever ` +
          `only ${from} holds into ${move.destination}, then replace ${from} with a relative symlink to it.`,
      };
    case "file":
      return {
        kind: "problem",
        message: `${from} is ${describe(node)}, but ${move.declaredBy} records that a directory moved from there to ${move.destination}.`,
      };
  }
}

const noUndeclaredDataDirsCheck: Check = {
  id: "paths:no-undeclared-data-dirs",
  description:
    "Every top-level entry under the singularity data root is a declared data dir (defineDataDir), one of the closed set of kinds, or a legacy name verified as the compatibility symlink to its declared target — and every entry INSIDE a kind directory is itself a declared <kind>/<name>, or a declared move's old location (movedFrom) verified as its shim or as a pending move.",
  // The subject is the MACHINE — one data root shared by every checkout on this
  // box, holding the union of every branch that has ever run here. Not the tree,
  // and not the dist this build produced, so no per-worktree caller can assert
  // it: a build observing this root sees state another live branch created,
  // which it did not cause and cannot repair. It was `scope: "deploy"` until
  // that difference cost a worktree its deploy — see the block comment above
  // rule 3 and research/2026-09-01-global-host-scoped-data-root-audit.md. A
  // non-tree-scoped check MUST supply a cacheSignature().
  scope: "host",
  cacheSignature(): string {
    // Everything the verdict reads: the root's listing, each kind directory's
    // listing (the second-level rule), what each legacy name actually is (the
    // symlink verification), and every other namespace's declaration manifest
    // (the attribution below). Folding in less than this is how a cached PASS
    // outlives the move it was recorded before — and, for the manifests
    // specifically, how a pass recorded while another checkout excused an entry
    // would replay green after that checkout was deleted and the entry became a
    // real orphan. The root listing does not change when a namespace goes away.
    const obs = observeRoot();
    if (obs.entries === null) return "no-root";
    const lines = [
      `manifests:${manifestStamps().join(",")}`,
      `root:${[...obs.entries].sort().join(",")}`,
      ...[...obs.kinds.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([kind, children]) => `${kind}/:${[...children].sort().join(",")}`,
        ),
      ...[...obs.legacy.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, node]) => `${name}=${describe(node)}`),
      `unmigrated:${[...obs.unmigratedKinds.keys()].sort().join(",")}`,
      // What each kind child IS, and what each symlinked one points at — the
      // facts a declared move's verdict turns on (settled shim vs pending real
      // directory). Derived from the root rather than from the registry, which
      // is not loaded yet when the signature is taken: the move SET is a
      // declaration, so the tree hash already covers it.
      //
      // One fact a move's verdict reads is NOT here: whether an AREA move's
      // destination (`apps/desktop/wallpaper`) exists while its old location is
      // still a real directory. Finding that path needs the registry. The gap is
      // one transition — a pending move turning into a split copy — and the
      // primitive never produces it (the mover renames; every other process
      // writes the OLD location), so a cached pass can only be outlived by
      // something writing the new location behind the primitive's back. The
      // resolution itself throws on the first read of such a root.
      ...[...obs.kindNodes.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, node]) => {
          const target = obs.linkTargets.get(key);
          return `${key}=${describe(node)}${target ? ` (target ${describe(target)})` : ""}`;
        }),
    ];
    return createHash("sha256").update(lines.join("\n")).digest("hex");
  },
  async run(ctx: CheckContext): Promise<CheckResult> {
    const obs = observeRoot();
    if (obs.entries === null) return { ok: true };

    // Loading the collected dir EVALUATES each owner's `data-dirs/index.ts`, and
    // the `defineDataDir` calls in them are what populate the registry. Read the
    // registry rather than the returned array, so declarations already made by
    // anything else in this process are counted too.
    await loadCollectedDir<DataDir>(dataDirsEntries, {
      isItem: isDataDir,
      dedupeKey: (d) => `${d.spec.kind}/${d.spec.name}`,
      label: "data-dir",
    });
    const declared = getDataDirs();
    // Both local sets from the ONE derivation each namespace publishes with, so
    // what this checkout checks itself against and what it publishes for others
    // cannot become two different answers.
    const local = declaredSets(declared);
    const declaredKeys = new Set(local.keys);
    // The grandfathered live services (postgres, sockets, zero, node): declared
    // where they already sit rather than moved under their kind.
    const permanent = new Set(local.rootEntries);

    // What the OTHER live namespaces on this machine declare. The data root is
    // host-global while `declared` above is one branch's view, so an entry a
    // concurrently-running agent's unmerged branch owns is invisible here — and
    // used to be reported as an orphan nobody could act on. See the manifest
    // module for the whole story.
    // `checkoutWorktreeName`, not `runtimeNamespace()`: this runs in a CLI
    // process, which declares no runtime namespace at all — only a
    // gateway-spawned backend does — so asking for one would throw.
    // Excluding the wrong namespace would leave OUR OWN possibly-stale manifest
    // in the foreign set, where it could excuse an entry this checkout has
    // stopped declaring — turning a real local orphan into someone else's.
    const foreign = readForeignManifests(
      checkoutWorktreeName(await getWorktreeRoot()),
    );
    /** Attributed entries, collected across both rules for one log line. */
    const attributed = new Map<string, string[]>();
    const owned = (
      candidates: readonly string[],
      which: "keys" | "rootEntries",
    ): string[] => {
      const split = partitionByOwner(candidates, foreign.manifests, which);
      for (const [name, owners] of split.attributed)
        attributed.set(name, owners);
      return split.orphans;
    };

    const table = legacyRootEntries();
    const tableNames = new Set(table.map((e) => e.name));
    const offenders: string[] = [];
    const moves = declaredMoves(declared);
    /** Declared moves whose old location is still a real directory, for one log line. */
    const pending: string[] = [];

    // Rule 1 — the top level. Every entry is a kind, a permanently-grandfathered
    // service, OS noise, or a name the legacy table accounts for.
    const undeclared = obs.entries.filter(
      (name) =>
        !OS_NOISE.has(name) &&
        !KIND_NAMES.has(name) &&
        !permanent.has(name) &&
        !tableNames.has(name),
    );
    for (const name of owned(undeclared.sort(), "rootEntries"))
      offenders.push(`${name} — undeclared entry at the data root`);

    // Rule 2 — the legacy names are VERIFIED, not merely tolerated.
    //
    // `drainable` excludes rows whose `from` is a kind name (`logs`): that entry
    // ends the migration as the kind directory, so counting it as never-drained
    // would make the tally read as permanently incomplete and the table look
    // undeletable.
    let drainable = 0;
    let drained = 0;
    for (const entry of table) {
      const node = obs.legacy.get(entry.name) ?? ABSENT;
      if (entry.expect.kind !== "kind-dir") {
        drainable++;
        if (node.node === "absent") drained++;
      }
      const problem = verifyLegacy(entry, node);
      if (problem !== null) offenders.push(problem);
    }

    // Rule 3 — the second level. Without this the check goes vacuous the moment
    // the top level is seven kind directories: a hand-made `state/foo` would
    // never be seen, because `state` itself is a kind and always passes rule 1.
    for (const [kind, children] of obs.kinds) {
      // The kind directory IS a legacy directory that has not moved yet, so its
      // contents are not kind-children and reporting them as undeclared would be
      // false. One line, naming the real problem.
      const destination = obs.unmigratedKinds.get(kind);
      if (destination !== undefined) {
        offenders.push(
          `${kind}/ has not been migrated yet — it is still the legacy directory, and its ` +
            `${children.length} entr(ies) move wholesale into ${destination}/ when the migration ` +
            `runs (${sample(children)}). Run \`bun plugins/infra/plugins/paths/scripts/` +
            `migrate-data-layout.ts\` to see the plan.`,
        );
        continue;
      }
      const candidates: string[] = [];
      for (const child of [...children].sort()) {
        if (OS_NOISE.has(child)) continue;
        const key = `${kind}/${child}`;
        if (declaredKeys.has(key)) continue;
        // A declared move's old location is judged by the move, BEFORE any
        // foreign manifest gets a say — see the rule 3 block comment.
        const move = moves.get(key);
        if (move !== undefined) {
          const verdict = verifyMove(
            key,
            obs.kindNodes.get(key) ?? ABSENT,
            move,
            inspect(obs.root, move.destination),
          );
          if (verdict.kind === "pending")
            pending.push(`${key} → ${move.destination}`);
          else if (verdict.kind === "problem") offenders.push(verdict.message);
          continue;
        }
        candidates.push(key);
      }
      for (const key of owned(candidates, "keys"))
        offenders.push(
          `${key} — inside a kind directory but not a declared \`${key}\``,
        );
    }

    // The table is only a to-do list if somebody is told when an item is done.
    // A drained row is one whose name has left the root entirely — the state
    // `--drop-legacy` produces, and the point at which its row can be deleted.
    ctx.log?.(
      `paths:no-undeclared-data-dirs: ${drained}/${drainable} legacy name(s) fully drained from ${obs.root}` +
        (drained === drainable
          ? " — the whole LEGACY_LAYOUT table can now be deleted, along with this rule and the migrate script."
          : ""),
      "stdout",
    );

    // A pending move is not a fault — it is the state between a declaration
    // merging and main booting on it. Said out loud so "the move has not
    // happened" is never mistaken for "the move is not needed".
    if (pending.length > 0) {
      ctx.log?.(
        `paths:no-undeclared-data-dirs: ${pending.length} declared move(s) pending under ${obs.root} — ` +
          `${pending.join(", ")}. The main backend performs each on its next boot on the merged code ` +
          `(it is the only process allowed to move shared data); until then every process reads the old location.`,
        "stdout",
      );
    }

    // Attributed entries are NOT offenders and are not silent either. This is a
    // normal state on a machine running several agents at once: the owning
    // branch simply has not merged yet, at which point the entry becomes
    // ordinarily declared here and this line stops mentioning it.
    if (attributed.size > 0) {
      ctx.log?.(
        `paths:no-undeclared-data-dirs: ${attributed.size} entr(ies) under ${obs.root} are ` +
          `declared by another live worktree rather than by this checkout — ` +
          `${describeAttribution(attributed)}. Nothing to do: they stop appearing here once ` +
          `those branches merge.`,
        "stdout",
      );
    }
    // A namespace publishing an unusable manifest attributes nothing, so its
    // live directories would surface above as orphans. Say so, or that reads as
    // an unexplained failure in a checkout that owns neither end of it.
    for (const bad of foreign.unreadable) {
      ctx.log?.(
        `paths:no-undeclared-data-dirs: ignoring ${bad.namespace}'s declaration manifest — ` +
          `${bad.reason}. Directories that namespace owns will be reported as undeclared ` +
          `until it publishes a readable one (its backend rewrites it on boot).`,
        "stderr",
      );
    }

    if (offenders.length === 0) return { ok: true };

    return {
      ok: false,
      message:
        `${offenders.length} problem(s) under the data root (${obs.root}):\n    ` +
        offenders.join("\n    "),
      hint:
        "An entry here is NOT necessarily yours. This root is shared by every checkout on the " +
        "machine, so a directory can belong to another live worktree whose branch has not merged " +
        "yet — those are recognised automatically from each namespace's published declaration " +
        "manifest and reported as owned, not as failures, so an entry reaching THIS list means no " +
        "live namespace on this machine declares it (one that has never booted publishes no " +
        "manifest; boot it and re-run). " +
        "Every directory under the data root has exactly one owning plugin. Declare it: create " +
        "`plugins/<owner>/data-dirs/index.ts` default-exporting a `DataDir[]` built with " +
        "`defineDataDir({ kind, name, owner, description, reclaim })` from " +
        "`@plugins/infra/plugins/paths/core`, then read `.path` / `.file(…)` / `.ensure()` from it " +
        "instead of joining the root by hand (see plugins/infra/plugins/paths/CLAUDE.md). An app's " +
        "content is NOT a new directory: each app owns exactly one, `apps/<app>/`, declared with " +
        "`defineAppDataDir(<app>, …)` in `plugins/apps/plugins/<app>/data-dirs/index.ts`, and a " +
        'sub-plugin\'s space inside it is `<app>Dir.subdir("<area>")`. A directory that MOVED ' +
        "records its old location on its declaration (`movedFrom`), which is what excuses the old " +
        "name here while the move is pending. If nothing " +
        "owns the entry any more, move it into `deprecated/` by hand — it is an orphan, and that is " +
        "the quarantine this check drains into. A legacy name reported as a real directory or file " +
        "where a shim belongs means either that the layout migration has not run on this root, or " +
        `that a pre-move writer replaced the shim it planted: \`${MIGRATE}\` (dry run), then ` +
        "`--apply`, which handles both. Do NOT add a name to LEGACY_LAYOUT — that table is a " +
        "self-liquidating record of what predates the registry, and nothing may be added to it.",
    };
  },
};

// ── data-root-not-joined ────────────────────────────────────────────────────
//
// The root has exactly one door, and this is what makes that true.
//
// `no-undeclared-data-dirs` above reads the real filesystem and fails on an
// undeclared entry — but only AFTER something has created it, which means the
// first report of a new orphan arrives with the orphan already on disk and
// possibly already holding the only copy of something. This check is the same
// invariant moved forward in time: it fails on the SPELLING that would mint one,
// before any build runs.
//
// Two ways back to a joinable root, and both are closed here:
//
//   1. **Joining `dataRoot()`.** The root is reachable as a plain string —
//      that is unavoidable, since a child process has to be handed one — so the
//      constraint cannot live in the type. `join(dataRoot(), "whatever")` is
//      precisely what `defineDataDir` exists to replace.
//   2. **Re-reading `SINGULARITY_DIR` from the environment.** A second
//      derivation of the root, in a plugin that owns none of it. This is the
//      form the deleted `SINGULARITY_DIR` const would come back as: not an
//      import (that is now a tsc error), but four characters of `process.env`.
//
// A WRITE to the env var is untouched — `??=`, `=`, and a `SINGULARITY_DIR:`
// key inside an `env: {…}` object are how a root is handed to a child, which is
// the sanctioned direction. Only reads are policed, which is why the pattern
// carries a negative lookahead for an assignment rather than matching the name.
//
// Modelled on `checks/plugins/host-pools-declared`, the established way this
// codebase makes a primitive the only door to a resource.

const DATA_ROOT_PATTERNS: { pattern: RegExp; grepArg: string }[] = [
  // join(dataRoot(), …) / resolve(dataRoot(), …)
  {
    pattern: /(?:join|resolve)\s*\(\s*dataRoot\s*\(\s*\)/,
    grepArg: "dataRoot",
  },
  // `${dataRoot()}/…` — the same join, spelled as concatenation.
  {
    pattern: /\$\{\s*dataRoot\s*\(\s*\)\s*\}[/\\]/,
    grepArg: "dataRoot",
  },
  // A READ of the env var. The lookahead lets an assignment through: `??=` and
  // `=` are writes, while `==` / `===` / `!==` are comparisons, i.e. reads.
  //
  // The inter-token whitespace lives INSIDE the lookahead deliberately. Written
  // as `…SINGULARITY_DIR\s*(?!…)` it matches every write instead: `\s*` is free
  // to give back the space it consumed, so the lookahead re-runs hard against
  // the name and sees " ??=" rather than "??=", finds no assignment, and the
  // negative succeeds. Both writes in the co-located test failed exactly that
  // way. `[ \t]` rather than `\s` because an assignment operator is always on
  // its target's line, and `\s` would let the scan run into the next one.
  {
    pattern: /process\.env\.SINGULARITY_DIR(?![ \t]*(?:\?\?)?=[^=])/,
    grepArg: "SINGULARITY_DIR",
  },
];

/**
 * The paths plugin owns the root, so it is the one tree that may name it (its
 * manifest exempts the whole plugin). Tests are out of scope categorically, not
 * by name: a test that points the root at a temp dir is being hermetic — the
 * correct thing for a test to do, and the alternative (running against the
 * developer's real `~/.singularity`) is the actual bug. Files that legitimately
 * read `SINGULARITY_DIR` declare it in their own plugin's manifest; entries
 * LEAVE it the moment their read does (a stale one fails this check).
 */
const dataRootNotJoinedCheck: Check = {
  id: "paths:data-root-not-joined",
  description:
    "The data root has one door: `dataRoot()` names it and nothing joins it. No `join(dataRoot(), …)`, and no re-reading SINGULARITY_DIR from the environment — a directory under the root is declared with defineDataDir.",
  exemptable: {
    "paths:data-root-not-joined":
      "joins the data root by hand or re-reads SINGULARITY_DIR from the environment instead of declaring a data dir",
  },
  outOfScope: ["research", "test"],
  async run(ctx) {
    const root = await getWorktreeRoot();
    const exempt = await ctx.exempt("paths:data-root-not-joined");
    const seen = new Set<string>();
    const offenders: string[] = [];

    for (const p of DATA_ROOT_PATTERNS) {
      const matches = await grepCode({
        root,
        pattern: p.pattern,
        grepArg: p.grepArg,
        // Template-literal interiors carry `${dataRoot()}`, which is CODE —
        // masking strings would hide exactly the concatenation form pattern 2
        // exists to catch. Comments and regex literals are masked either way.
        maskStrings: false,
      });

      for (const m of matches) {
        const line = `${m.path}:${m.line}:${m.text}`;
        if (seen.has(line)) continue;
        seen.add(line);

        if (exempt.skips(m.path)) continue;

        offenders.push(line);
      }
    }

    if (offenders.length === 0) return { ok: true };

    return {
      ok: false,
      message: `the data root is named by hand in ${offenders.length} place(s):\n    ${offenders.join("\n    ")}`,
      hint:
        "A directory under the data root is a DECLARATION, not a join. Create " +
        "`plugins/<owner>/data-dirs/index.ts` default-exporting a `DataDir[]` built with " +
        "`defineDataDir({ kind, name, owner, description, reclaim })`, then read `.path` / " +
        "`.file(…)` / `.ensure()` from it — see plugins/infra/plugins/paths/CLAUDE.md. " +
        "For an app's content, do not declare a directory at all: use an area of the app's one " +
        'data dir, `<app>Dir.subdir("<area>")` (declared once with `defineAppDataDir` at the ' +
        "app's root). " +
        "`dataRoot()` names the ROOT ITSELF and its only use is handing that root to a child " +
        "process (or reporting it); to express a declared location under a root that is not this " +
        "process's own, use `relativeToDataRoot(dir, …)` rather than re-deriving the layout. " +
        "Reading `process.env.SINGULARITY_DIR` is a second derivation of the root — WRITING it " +
        "(`=`, `??=`, or an `env: {…}` key) is the sanctioned handoff and is not flagged.",
    };
  },
};

// ── app-data-dirs ───────────────────────────────────────────────────────────
//
// One data dir per app, `apps/<app>/`, holding everything that app keeps
// durably. `defineDataDir` refusing the `apps` kind is the type-level half; this
// is the half a type cannot see — WHERE each declaration is made, and whether
// the app it names is the app it is made from. The rules themselves are pure
// and live in `core/internal/app-data-dirs.ts`; this check only gathers facts.
//
// Unlike `no-undeclared-data-dirs` it reads no filesystem state, only the tree:
// the declarations (each generated entry's module, evaluated) and the call
// sites (grep). So it is `scope: "tree"` and runs in every build, check and
// push — the moment a second `apps/*` dir is written, not after it exists on
// somebody's disk.
//
// Each entry's loader is called HERE rather than read back off the registry,
// because the registry has forgotten who declared what: pairing an item with
// the entry whose default export listed it is the only way to know its real
// declaring plugin, which is what rules A–C are about.

const appDataDirsCheck: Check = {
  id: "paths:app-data-dirs",
  description:
    "Each app owns exactly one data dir, apps/<app>/, declared by the app's root plugin with defineAppDataDir; an app's durable (reclaim: never) data lives inside it, never beside it; every declaration's owner is its declaring plugin; and declarations are made only in a data-dirs/index.ts.",
  async run() {
    const declarations: DataDirDeclaration[] = [];
    const offenders: string[] = [];

    for (const entry of dataDirsEntries) {
      let mod: { default: unknown };
      try {
        mod = await entry.loader();
      } catch (err) {
        // Not absorbed: rethrown with the one fact the raw error lacks — which
        // entry it was, and that a stale registry is the usual cause.
        throw new Error(
          `[paths:app-data-dirs] loading plugins/${entry.pluginPath}/data-dirs/index.ts failed: ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `(If that file was moved or deleted, run \`./singularity build\` to regenerate core/data-dirs.generated.ts.)`,
          { cause: err },
        );
      }
      const items = Array.isArray(mod.default) ? mod.default : [mod.default];
      for (const item of items) {
        if (!isDataDir(item)) {
          offenders.push(
            `plugins/${entry.pluginPath}/data-dirs/index.ts default-exports something that is not a DataDir ` +
              `(${typeof item}). Its default export must be a DataDir or a DataDir[] of the declarations it makes.`,
          );
          continue;
        }
        declarations.push({ pluginPath: entry.pluginPath, spec: item.spec });
      }
    }
    offenders.push(...evaluateDataDirDeclarations(declarations));

    const matches = await grepCode({
      root: await getWorktreeRoot(),
      pattern: DECLARATION_CALL_PATTERN,
      grepArg: "DataDir",
      fixed: true,
      // Strings AND comments masked (the default): prose that names the two
      // functions — a docblock, a hint message — is never a call.
    });
    offenders.push(...evaluateDeclarationCallSites(matches));

    if (offenders.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${offenders.length} data-dir declaration problem(s):\n    ${offenders.join("\n    ")}`,
      hint:
        "Each app owns exactly ONE data dir, `apps/<app>/`: declared once with " +
        "`defineAppDataDir(<app>App, { owner, description })` in the app's root " +
        "`plugins/apps/plugins/<app>/data-dirs/index.ts`. Everything the app and its sub-plugins keep durably goes " +
        'inside it: a sub-plugin imports that declaration and takes an area with `.subdir("<area>")`. ' +
        "Re-derivable output stays outside, under cache/. Every other directory is " +
        "`defineDataDir({ kind, name, owner, description, reclaim })` in the owning plugin's own " +
        "data-dirs/index.ts, with `owner` = that plugin's path minus its `/plugins/` segments. " +
        "See plugins/infra/plugins/paths/CLAUDE.md.",
    };
  },
};

export default [
  noHardcodedPathsCheck,
  noInlinedWorktreeArtifactsCheck,
  noUndeclaredDataDirsCheck,
  dataRootNotJoinedCheck,
  appDataDirsCheck,
];
