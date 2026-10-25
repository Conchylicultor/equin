#!/usr/bin/env bun
/**
 * One-time repair: move the data root onto the declared
 * `<kind>/<name>` layout that `defineDataDir` describes but the disk never had.
 *
 * Two passes, because a bare rename breaks every worktree still running pre-move
 * code — its backend keeps naming the old path:
 *
 *   pass 1 (`--apply`)        rename the bytes to `<kind>/<name>`, then SYMLINK
 *                             the old name at the new one. Exactly one copy of
 *                             the bytes; old code reaches it through the shim.
 *   pass 2 (`--drop-legacy`)  once every worktree has rebuilt, delete the shims
 *                             and sweep the strays the shim scheme can leave.
 *
 * The DECISION is not here. `planMigration()` (pure, unit-tested, beside the
 * `LEGACY_LAYOUT` table in `paths/core/internal/legacy-layout.ts`) turns
 * filesystem facts into a list of steps; this script reads the facts, prints the
 * steps, and — only when asked — executes them. Rename, never copy.
 *
 * Not a CLI command, deliberately: this is a historical repair that becomes a
 * no-op the moment it has run, not a capability the tool should carry forever.
 * It is deleted together with the table and `planMigration` once every root has
 * been migrated. Same shape as `server-core/scripts/backfill-pushes.ts`.
 *
 * Usage:
 *   ./equin run plugins/infra/plugins/paths/scripts/migrate-data-layout.ts                # dry run
 *   ./equin run plugins/infra/plugins/paths/scripts/migrate-data-layout.ts --apply        # pass 1
 *   ./equin run plugins/infra/plugins/paths/scripts/migrate-data-layout.ts --drop-legacy  # pass 2
 *
 * No flag prints BOTH passes' plans and touches nothing. Pass 2 deletes things,
 * so it gets a reviewable dry run too — and there is no `--dry-run
 * --drop-legacy` spelling to get wrong. Pass 2 is planned against the state
 * pass 1 WOULD LEAVE (simulated in memory, since `planMigration` is pure), not
 * against the root as it is now: on an un-migrated root pass 2 reads the
 * original files as strays, which is the opposite of predictive.
 *
 * `--apply` REFUSES while a gateway is alive. There is no `--force`: the gateway
 * holds sockets and pidfiles under the very entries being renamed, and "I know
 * what I'm doing" is not a thing a flag can check.
 *
 * KNOWN LIMITATION, in the other direction: the `logs/` staging dance refuses on
 * any child that is not a plain FILE, because the gateway writes only
 * `<worktree>.log` and its rotations. A non-gateway PLAIN FILE therefore passes
 * the test and is carried down into `logs/gateway/` with everything else —
 * nothing is lost, but it is misfiled. The launchd monitors' own logs did
 * exactly this on the first real run. Enumerating non-gateway filenames would
 * be the list-versus-invariant trap this check exists to avoid, so the
 * limitation is stated rather than patched.
 *
 * It also refuses, in EITHER pass and changing nothing, if anything already
 * occupies a `<kind>/<name>` destination. That is always new code writing to the
 * new layout on an un-migrated root, and there is no correct automatic answer —
 * so the refusal prints what is there, how big and how fresh it is, where the
 * real history still sits, and the exact `rm` line to review.
 *
 * And `--drop-legacy` refuses outright unless pass 1 has run: the passes have an
 * order, nothing else enforces it, and pass 2 on an un-migrated root would
 * delete originals it mistook for leftovers.
 */

import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { isRunning, readPid } from "@plugins/infra/plugins/launcher/server";
// Own-plugin, so relative — the `@plugins/infra/plugins/paths/core` alias would
// name this plugin from inside itself. Same shape as `check/index.ts`, and it
// keeps the script working off the table's full surface rather than only the
// subset the barrel re-exports.
import { dataRoot } from "../core/internal/data-dir";
import {
  LEGACY_LAYOUT,
  legacyRootEntries,
  planMigration,
  rowRootNames,
  simulateSteps,
  stagingName,
} from "../core/internal/legacy-layout";
import type {
  FsEntry,
  MigrationMode,
  MigrationStep,
} from "../core/internal/legacy-layout";

// ── mode ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const DROP = argv.includes("--drop-legacy");

const unknown = argv.filter((a) => a !== "--apply" && a !== "--drop-legacy");
if (unknown.length > 0) {
  console.error(`Unknown argument(s): ${unknown.join(" ")}`);
  console.error(
    "Usage: bun plugins/infra/plugins/paths/scripts/migrate-data-layout.ts [--apply | --drop-legacy]",
  );
  process.exit(2);
}
if (APPLY && DROP) {
  console.error(
    "--apply and --drop-legacy are two separate passes, run days apart. Pick one.",
  );
  process.exit(2);
}

const MODE: MigrationMode = DROP ? "drop-legacy" : "apply";
const WRITE = APPLY || DROP;
const ROOT = dataRoot();

// ── reading the facts `planMigration` needs ──────────────────────────────────

const abs = (relPath: string): string => join(ROOT, ...relPath.split("/"));

/**
 * One filesystem fact, or `undefined` when nothing is there. A symlink's target
 * is normalized to a ROOT-RELATIVE `/`-path so the planner — which touches no
 * filesystem and knows no absolute root — can compare it to a `<kind>/<name>`
 * ref by string equality.
 *
 * `withChildren` gates the `readdirSync`. Only destinations and the self-nesting
 * source need their contents (see `FsEntry`), and `closure-cache` has ~190k
 * entries — enumerating every source would cost seconds and buy nothing.
 */
function inspect(relPath: string, withChildren: boolean): FsEntry | undefined {
  const full = abs(relPath);
  const st = lstatSync(full, { throwIfNoEntry: false });
  if (!st) return undefined;
  if (st.isSymbolicLink()) {
    const raw = readlinkSync(full);
    const target = isAbsolute(raw) ? raw : resolve(dirname(full), raw);
    return {
      path: relPath,
      node: "symlink",
      target: relative(ROOT, target).split(sep).join("/"),
    };
  }
  if (!st.isDirectory()) return { path: relPath, node: "file" };
  if (!withChildren) return { path: relPath, node: "dir" };
  // `withFileTypes` so each child carries whether it is a plain FILE, in one
  // syscall. The self-nesting check turns on exactly that (see `DirChild`), and
  // a per-child lstat over the gateway's 1500 logs would not be free.
  const children = readdirSync(full, { withFileTypes: true }).map((d) => ({
    name: d.name,
    file: d.isFile(),
  }));
  return { path: relPath, node: "dir", children };
}

/**
 * Every path the planner may ask about: each row's root name(s) and rotation
 * siblings, each destination `<kind>/<name>`, each `deprecated/<name>`, and the
 * staging directory a self-nesting row moves through. A path absent from this
 * list reads as absent from disk, so under-collecting here would silently
 * mis-plan — which is why it is derived from the table rather than hand-listed.
 */
function snapshot(): FsEntry[] {
  // Destinations, plus the self-nesting source (root `logs`, whose own children
  // are where new-code strays hide). Everything else is lstat-only.
  const enumerate = new Set<string>();
  const paths = new Set<string>();
  for (const row of LEGACY_LAYOUT) {
    for (const name of rowRootNames(row)) paths.add(name);
    if (row.move === "quarantine") {
      const dest = `deprecated/${row.from}`;
      paths.add(dest);
      enumerate.add(dest);
    } else {
      paths.add(row.to);
      enumerate.add(row.to);
    }
    if (row.move === "dir" && row.to.startsWith(`${row.from}/`)) {
      const staging = stagingName(row.from);
      paths.add(staging);
      enumerate.add(staging);
      enumerate.add(row.from);
    }
  }
  const entries: FsEntry[] = [];
  for (const p of [...paths].sort()) {
    const entry = inspect(p, enumerate.has(p));
    if (entry) entries.push(entry);
  }
  return entries;
}

// ── printing ─────────────────────────────────────────────────────────────────

function describeStep(step: MigrationStep): string {
  switch (step.action) {
    case "rename":
      return `RENAME     ${step.from}  →  ${step.to}`;
    case "symlink":
      return `SYMLINK    ${step.at}  →  ${step.target}   (compat shim)`;
    case "mkdir":
      return `MKDIR      ${step.path}`;
    case "quarantine":
      return `QUARANTINE ${step.from}  →  ${step.to}\n             ${step.reason}`;
    case "unlink":
      return `REMOVE     ${step.path}   (${step.reason})`;
    case "blocked":
      return `BLOCKED    ${step.path}\n             ${step.reason}`;
  }
}

const LIST_CAP = 10;

/** Bytes for a file, `N entries` for a directory — the cheap shape of a path. */
function sizeOf(relPath: string): string {
  const full = abs(relPath);
  const st = lstatSync(full, { throwIfNoEntry: false });
  if (!st) return "(gone)";
  if (st.isDirectory()) {
    const children = readdirSync(full);
    const head = children.slice(0, LIST_CAP).join(", ");
    const tail =
      children.length > LIST_CAP
        ? `, … and ${children.length - LIST_CAP} more`
        : "";
    return `${children.length} entr(ies)${children.length > 0 ? `: ${head}${tail}` : ""}`;
  }
  return `${st.size} bytes`;
}

function mtimeOf(relPath: string): string {
  const st = lstatSync(abs(relPath), { throwIfNoEntry: false });
  return st ? st.mtime.toISOString() : "(gone)";
}

/**
 * Is the destination NEWER than the legacy data it stands in front of?
 *
 * This is what separates "minutes of re-derivable state a backend just wrote"
 * from "an archive that has been here since April". Both look identical to the
 * structural test — a non-empty directory at a `<kind>/<name>` path — and the
 * FIRST real run of this script proved why the difference has to be acted on:
 * `logs/fd-monitor-incidents` was 11 MB of fd-monitor captures from months
 * earlier, and a blanket remedy would have suggested deleting it.
 *
 * Something older than the data it shadows cannot be output from code that did
 * not exist yet, so it is never safe to discard mechanically. `null` means the
 * comparison could not be made, which is treated as "cannot prove it is fresh".
 */
function destinationIsNewerThanHistory(
  step: Extract<MigrationStep, { action: "blocked" }>,
): boolean | null {
  const dest = lstatSync(abs(step.path), { throwIfNoEntry: false });
  const history = lstatSync(abs(step.row), { throwIfNoEntry: false });
  if (!dest || !history) return null;
  return dest.mtime.getTime() > history.mtime.getTime();
}

/**
 * Print the refusal. Everything a person needs to decide, and nothing they have
 * to go and look up: what is at the destination, how big and how fresh it is,
 * where the real history still sits, and the exact command to review.
 */
function reportBlocked(steps: readonly MigrationStep[]): void {
  const blocked = steps.filter((s) => s.action === "blocked");
  console.error(
    `\nSTOPPING: ${blocked.length} problem(s). NOTHING was changed.\n`,
  );

  const discard = blocked.filter((s) => s.remedy === "discard-destination");
  const inspectMe = blocked.filter((s) => s.remedy === "inspect");

  if (discard.length > 0) {
    console.error(
      [
        "New code has already written to the new layout on this root.",
        "",
        "Nothing legitimately lives at a <kind>/<name> path before this migration runs, so each",
        "path below is output some backend produced against an un-migrated root — minutes of",
        "re-derivable state standing in front of the real history, which is still at the legacy",
        "path. There is no correct automatic merge: keeping either side silently discards the",
        "other, and a legacy directory left non-empty would suppress its compatibility symlink,",
        "splitting old and new code onto two disjoint copies.",
        "",
      ].join("\n"),
    );
    for (const step of discard) {
      console.error(`  ${step.path}`);
      console.error(`      new:     ${sizeOf(step.path)}`);
      console.error(`      mtime:   ${mtimeOf(step.path)}`);
      console.error(`      history: ${step.row} — ${sizeOf(step.row)}`);
      console.error(`      why:     ${step.reason}`);
      console.error("");
    }
    // One contamination can be reported by two rows (the `logs` row sees the
    // stray `logs/op-log` directory, the `op-log.jsonl` row sees the file inside
    // it), so drop any path an already-listed path contains — otherwise the
    // operator is handed a second `rm` for something the first already removed.
    const roots = discard
      .filter(
        (s, _i, all) =>
          !all.some(
            (other) => other !== s && s.path.startsWith(`${other.path}/`),
          ),
      )
      .filter((s, i, all) => all.findIndex((o) => o.path === s.path) === i);

    // Split on the ONE fact that separates re-derivable output from data: is
    // the destination newer than the history it stands in front of? A blanket
    // `rm` list is a remedy people paste whole — and on the first real run of
    // this script that list contained 11 MB of fd-monitor captures from four
    // months earlier, sitting alongside 0-byte markers written minutes before.
    // Anything not PROVABLY newer gets no command at all.
    const fresh = roots.filter(
      (s) => destinationIsNewerThanHistory(s) === true,
    );
    const notFresh = roots.filter(
      (s) => destinationIsNewerThanHistory(s) !== true,
    );

    if (fresh.length > 0) {
      console.error(
        [
          "These are newer than the data they shadow — backend output, safe to discard.",
          "With the cluster stopped, review and remove them, then run this again:",
          "",
          ...fresh.map((s) => {
            const st = lstatSync(abs(s.path), { throwIfNoEntry: false });
            return `    rm ${st?.isDirectory() ? "-rf" : "-f"} ${abs(s.path)}`;
          }),
          "",
        ].join("\n"),
      );
    }

    if (notFresh.length > 0) {
      console.error(
        [
          "NOT safe to delete — and deliberately given no command:",
          "",
          ...notFresh.flatMap((s) => [
            `  ${abs(s.path)}`,
            `      mtime ${mtimeOf(s.path)}, which is NOT newer than the legacy`,
            `      "${s.row}" (${mtimeOf(s.row)}) it stands in front of.`,
            "      It cannot be output from code that did not exist yet, so something",
            "      else owns it. Move it somewhere safe and decide by hand.",
            "",
          ]),
        ].join("\n"),
      );
    }
  }

  if (inspectMe.length > 0) {
    console.error("Needs a look — no safe mechanical answer:\n");
    for (const step of inspectMe) {
      console.error(`  ${step.path} (row "${step.row}")`);
      console.error(`      ${step.reason}`);
      console.error("");
    }
  }
}

// ── executing ────────────────────────────────────────────────────────────────

/** `rename`, with the destination's parent created first. Never a copy. */
function renameInto(fromRel: string, toRel: string): void {
  mkdirSync(dirname(abs(toRel)), { recursive: true });
  renameSync(abs(fromRel), abs(toRel));
}

/** Remove an entry whatever it is: a symlink, a file, or an empty directory. */
function removeEntry(relPath: string): void {
  const full = abs(relPath);
  const st = lstatSync(full, { throwIfNoEntry: false });
  if (!st) return;
  // A symlink TO a directory is still a link — `isDirectory()` on an lstat is
  // false for it, which is exactly the distinction that matters here. `rmdir`
  // (not `rm -rf`) so a directory that is unexpectedly non-empty throws rather
  // than being deleted: this script never removes content it did not plan for.
  if (st.isDirectory()) rmdirSync(full);
  else unlinkSync(full);
}

function execute(step: MigrationStep): void {
  switch (step.action) {
    case "rename":
    case "quarantine":
      renameInto(step.from, step.to);
      return;
    case "symlink":
      // A RELATIVE link body, so the shim survives the whole root being moved
      // or bind-mounted (a release preview roots at /tmp). An absolute link
      // would silently point back at the original root.
      symlinkSync(relativeLink(step.at, step.target), abs(step.at));
      return;
    case "mkdir":
      mkdirSync(abs(step.path), { recursive: true });
      return;
    case "unlink":
      removeEntry(step.path);
      return;
    case "blocked":
      // Unreachable: a plan containing one of these never gets executed.
      throw new Error(
        `[migrate] refusing to execute a blocked step: ${step.path}`,
      );
  }
}

/** The symlink body: `target` expressed relative to the directory holding `at`. */
function relativeLink(at: string, target: string): string {
  const fromDir = dirname(abs(at));
  return relative(fromDir, abs(target)).split(sep).join("/");
}

// ── the gateway guard ────────────────────────────────────────────────────────

/**
 * The gateway's pid, from wherever the pidfile currently is.
 *
 * `readPid()` names the pidfile the way THIS checkout does — which, on new code,
 * is already `locks/gateway/gateway.pid`. Before pass 1 that file does not
 * exist, so trusting `readPid()` alone would make the guard silently vacuous at
 * exactly the moment it matters. The legacy spelling is read from the table
 * rather than typed a second time.
 */
function liveGatewayPid(): number | null {
  const fromDeclaration = readPid();
  if (fromDeclaration !== null) return fromDeclaration;
  const legacy = LEGACY_LAYOUT.find(
    (row) => row.move === "file" && row.to === "locks/gateway",
  );
  if (!legacy) return null;
  const path = abs(legacy.from);
  if (!existsSync(path)) return null;
  const n = parseInt(readFileSync(path, "utf-8").trim(), 10);
  return Number.isNaN(n) ? null : n;
}

function refuseIfGatewayAlive(): void {
  const pid = liveGatewayPid();
  if (pid === null || !isRunning(pid)) return;
  console.error(
    [
      "",
      `REFUSING: the gateway is running (pid ${pid}).`,
      "",
      "It holds sockets, pidfiles and log handles under the very entries this pass",
      "renames, and it supervises every backend that would keep writing to them.",
      "Stop it, run this again, then start it back up:",
      "",
      `    kill ${pid}`,
      "    bun plugins/infra/plugins/paths/scripts/migrate-data-layout.ts --apply",
      "    ./equin start",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

// ── run ──────────────────────────────────────────────────────────────────────

function printPlan(title: string, steps: readonly MigrationStep[]): void {
  console.log(title);
  if (steps.length === 0) {
    console.log("  (nothing to do)\n");
    return;
  }
  let row = "";
  for (const step of steps) {
    if (step.row !== row) {
      row = step.row;
      console.log(`  ── ${row}`);
    }
    console.log(`  ${describeStep(step)}`);
  }
  const counts = new Map<MigrationStep["action"], number>();
  for (const step of steps)
    counts.set(step.action, (counts.get(step.action) ?? 0) + 1);
  console.log(
    `\n  ${steps.length} step(s) — ` +
      [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([action, n]) => `${n} ${action}`)
        .join(", ") +
      "\n",
  );
}

/** How much of the table has left the root for good — the tally that reaches zero work. */
function drainedTally(): string {
  // Only names that CAN leave the root are counted: a row whose `from` is a kind
  // name (`logs`) ends the migration as the kind directory, so counting it as
  // never-drained would make the tally read as permanently incomplete.
  const drainable = legacyRootEntries().filter(
    (e) => e.expect.kind !== "kind-dir",
  );
  const drained = drainable.filter(
    (e) => inspect(e.name, false) === undefined,
  ).length;
  return `${drained}/${drainable.length} legacy name(s) fully drained from the root`;
}

console.log(`Root: ${ROOT}`);
console.log(
  `Mode: ${
    !WRITE
      ? "DRY RUN — both passes, planned against the root as it is right now"
      : APPLY
        ? "APPLY — pass 1: move the bytes, leave the shims"
        : "DROP-LEGACY — pass 2: remove the shims and sweep the strays"
  }\n`,
);

if (!existsSync(ROOT)) {
  console.log("The data root does not exist. Nothing to migrate.");
  process.exit(0);
}

if (APPLY) refuseIfGatewayAlive();

const facts = snapshot();

// No flag: show what BOTH passes would do, so pass 2 — the destructive one — is
// reviewable too. There is no `--dry-run --drop-legacy` spelling to get wrong,
// and after pass 1 has run the first section is simply empty.
if (!WRITE) {
  const applyPlan = planMigration(facts, "apply");
  printPlan("Pass 1 (--apply) — move the bytes, leave the shims:\n", applyPlan);

  const applyBlocked = applyPlan.some((s) => s.action === "blocked");
  if (applyBlocked) {
    // Pass 2 is only meaningful against the state pass 1 leaves. Pass 1 cannot
    // run, so there is no such state, and planning pass 2 against the root as it
    // is now would describe originals as strays — the exact misreading the
    // precondition exists to stop. Say that instead.
    console.log(
      "Pass 2 (--drop-legacy):\n\n  (not shown — pass 1 cannot run yet, so there is no post-pass-1 state to plan against)\n",
    );
  } else {
    // Simulate pass 1 in memory so pass 2 is planned against the state it will
    // actually meet. `planMigration` is pure, so this is exact.
    printPlan(
      "Pass 2 (--drop-legacy) — planned against the state pass 1 would leave:\n",
      planMigration(simulateSteps(facts, applyPlan), "drop-legacy"),
    );
  }

  console.log(`${drainedTally()}.`);
  console.log(
    applyBlocked
      ? "\n[DRY RUN] Nothing was touched — and a real run would STOP on the BLOCKED entries above."
      : "\n[DRY RUN] Nothing was touched.",
  );
  process.exit(0);
}

const steps = planMigration(facts, MODE);

// ONE rule for both passes: any blocked step stops everything. No flag overrides
// it and no partial application is attempted — a migration that got halfway and
// then hit a collision is strictly harder to reason about than one that never
// started, and the operator resolving the collision wants a root in a state they
// can still describe.
if (steps.some((s) => s.action === "blocked")) {
  printPlan("Plan (NOT executed):\n", steps);
  reportBlocked(steps);
  process.exit(1);
}

if (steps.length === 0) {
  console.log(`Nothing to do — ${drainedTally()}.`);
  process.exit(0);
}

printPlan("Plan:\n", steps);

console.log("Executing...\n");
for (const step of steps) {
  // Deliberately unguarded: an EEXIST/EBUSY here means the plan was computed
  // against a root that changed underneath it, and continuing would compound it.
  // The pass is resumable — re-running re-plans from whatever state it stopped in.
  execute(step);
}

console.log(`Done. ${steps.length} step(s) executed.`);
if (APPLY)
  console.log(
    "\nNow start the gateway again: ./equin start\n" +
      "Then `ls -l` the root: every legacy name should be a symlink into its kind dir.",
  );
