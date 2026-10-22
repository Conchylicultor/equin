/**
 * The migration half of the clone journey: a clone that lands its OWN schema
 * migrations and then takes upstream updates that carry upstream's, driven
 * through the real CLI against a copy of this very tree.
 *
 * Why a copy of the real tree rather than a text fixture: drizzle-kit reads the
 * real schema files, the real snapshot chain and the real phased-migration
 * grammar, so only the real tree exercises what a clone user's push and update
 * actually do. Plan: `research/2026-09-30-global-clone-migrations-published-set.md` §5.
 *
 * The repositories, all under the caller's temp dir (`<id>` is per run):
 *
 *   e2e-cj-<id>-up/        `git clone --shared` of THIS checkout, on `main` =
 *                          this checkout's HEAD plus (unless `--pristine`) its
 *                          uncommitted working-tree state, committed there as
 *                          one overlay commit — nothing in a worktree is
 *                          committed until push, so HEAD alone would test
 *                          yesterday's code. No remote: it is the author.
 *   e2e-cj-<id>-clone/     `git clone` of upstream that KEEPS the remote name
 *                          `origin` — what `install.sh` / `git clone` leave, and
 *                          the shape in which `origin/main` is the AUTHOR's main
 *                          (Problem 1). On `main`: push fast-forwards it here.
 *   e2e-cj-<id>-clone-wt/  linked worktree of the clone, where its branches
 *                          live and every clone-side `./singularity` runs.
 *
 * Nothing here is special-cased for being a test. A repository other than the
 * one this machine's main app is served from names its main checkout by its
 * directory (`checkoutRef`), so the upstream's CLI calls run in its own main
 * checkout without touching main's namespace. The clone's origin is a local
 * path, which `resolvePublishTarget` answers `local` from the URL. Pushes are
 * the real `./singularity push`: its lock is the clone's own (`pushLockFor`),
 * its `migration-applies-clean` dry-runs against the clone's own main database
 * (a throwaway one, as that main was never deployed), and it refuses to land on
 * any repository but the clone's. On top of that, every push first asserts that
 * it lands under the temp dir, and the run ends by asserting that no commit of
 * this fixture reached THIS repository's `main` or `origin/main`.
 *
 * Assertions are on git state and generated files only. No database is touched:
 * the database consequence of a renamed migration (the runner re-applies DDL
 * keyed by the new sha8) is mechanical and covered by the runner's own tests.
 */
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { resolvePublishTarget } from "@plugins/infra/plugins/git/plugins/remotes/core";
import {
  spawnCaptured,
  type SpawnResult,
} from "@plugins/infra/plugins/spawn/core";

export type Check = (label: string, ok: boolean, detail?: string) => void;

const DATA = "plugins/database/plugins/migrations/data";
const META = `${DATA}/meta`;
const JOURNAL = "_journal.json";
/** The live tip snapshot: rewritten (never added) by every schema migration. */
const TIP = `${META}/schema.snapshot.json`;

/** Probe schema files: matched by drizzle.config's `tables-*.ts` glob. */
const UPSTREAM_PROBE =
  "plugins/upstream/server/internal/tables-e2e-upstream.ts";
const CLONE_PROBE = "plugins/upstream/server/internal/tables-e2e-clone.ts";
const UPSTREAM_TABLE = "e2e_upstream_probe";

const GIT_TIMEOUT_MS = 120_000;
/**
 * Every `./singularity` call. The first one in each worktree installs that
 * worktree's dependencies (a cold `bun install` plus provisions), and each
 * regen loads every schema file through drizzle-kit — minutes, not seconds.
 */
const CLI_TIMEOUT_MS = 20 * 60_000;
/** A push runs the whole tree-scoped check pass (type-check included). */
const PUSH_TIMEOUT_MS = 45 * 60_000;

/** A named failure of the FIXTURE (not a test result): stops the phase. */
class HarnessError extends Error {}

interface Ctx {
  tmp: string;
  source: string;
  upstream: string;
  clone: string;
  upWt: string;
  cloneWt: string;
  logDir: string;
  check: Check;
  cliSeq: number;
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.t",
};

async function gitRaw(cwd: string, args: string[]): Promise<SpawnResult> {
  return await spawnCaptured(["git", ...args], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    env: { ...process.env, ...GIT_ENV },
  });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await gitRaw(cwd, args);
  if (r.exitCode !== 0) {
    throw new HarnessError(
      `git ${args.join(" ")} failed in ${cwd} (exit ${r.exitCode}):\n${r.stderr}`,
    );
  }
  return r.stdout.trim();
}

/** `./singularity <args>` in `cwd`, captured, full output kept in the log dir. */
async function cli(
  ctx: Ctx,
  cwd: string,
  args: string[],
  timeoutMs = CLI_TIMEOUT_MS,
): Promise<SpawnResult> {
  const started = Date.now();
  const r = await spawnCaptured(["./singularity", ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    timeoutMs,
  });
  ctx.cliSeq += 1;
  const log = join(
    ctx.logDir,
    `${String(ctx.cliSeq).padStart(2, "0")}-${args.join("_").replace(/[^\w.-]+/g, "-")}.log`,
  );
  writeFileSync(
    log,
    `$ (cd ${cwd} && ./singularity ${args.join(" ")})\nexit ${r.exitCode}${r.timedOut ? " (TIMED OUT)" : ""}\n\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`,
  );
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(
    `    $ ./singularity ${args.join(" ")}  → exit ${r.exitCode} (${secs}s, ${log})`,
  );
  if (r.timedOut)
    throw new HarnessError(`./singularity ${args.join(" ")} timed out`);
  return r;
}

/** The last `n` non-empty lines of a run's combined output, for a check detail. */
function tail(r: SpawnResult, n = 15): string {
  const lines = `${r.stdout}\n${r.stderr}`
    .split("\n")
    .filter((l) => l.trim().length > 0);
  return `\n      ${lines.slice(-n).join("\n      ")}`;
}

// --- migration-file reads -----------------------------------------------------

/** Every migration file under data/ (and meta/) at `ref`, path → blob sha. */
async function filesAt(cwd: string, ref: string): Promise<Map<string, string>> {
  const out = await git(cwd, "ls-tree", "-r", ref, "--", DATA);
  const map = new Map<string, string>();
  for (const line of out.split("\n").filter(Boolean)) {
    // "<mode> blob <sha>\t<path>"
    const [meta, path] = line.split("\t");
    const sha = meta!.split(" ")[2]!;
    if (path!.endsWith(JOURNAL)) continue;
    map.set(path!, sha);
  }
  return map;
}

/** The same, read from the working tree (blob shas via `git hash-object`). */
async function filesOnDisk(cwd: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const paths: string[] = [];
  for (const f of readdirSync(join(cwd, DATA))) {
    if (f.endsWith(".sql")) paths.push(`${DATA}/${f}`);
  }
  for (const f of readdirSync(join(cwd, META))) {
    if (f !== JOURNAL && f.endsWith(".json")) paths.push(`${META}/${f}`);
  }
  if (paths.length === 0) return map;
  const shas = (await git(cwd, "hash-object", "--", ...paths)).split("\n");
  paths.forEach((p, i) => map.set(p, shas[i]!));
  return map;
}

/** Files in `after` that are absent from `before` (added, by path). */
function added(
  before: Map<string, string>,
  after: Map<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [p, sha] of after) if (!before.has(p)) out.set(p, sha);
  return out;
}

const sqlOf = (files: Map<string, string>): string[] =>
  [...files.keys()].filter((p) => p.endsWith(".sql")).sort();

/** Whether the tip snapshot differs between two file maps (a new schema tip). */
const retipped = (
  before: Map<string, string>,
  after: Map<string, string>,
): boolean => after.has(TIP) && before.get(TIP) !== after.get(TIP);

const basename = (p: string): string => p.split("/").pop()!;

/**
 * Which of `expected` (published path → blob sha) the working tree no longer
 * holds byte-identically: deleted, renamed, or rewritten. Empty = all intact.
 */
async function notIntact(
  cwd: string,
  expected: Map<string, string>,
): Promise<string[]> {
  const disk = await filesOnDisk(cwd);
  const bad: string[] = [];
  for (const [p, sha] of expected) {
    const got = disk.get(p);
    if (got === undefined) bad.push(`${basename(p)} (missing)`);
    else if (got !== sha) bad.push(`${basename(p)} (content changed)`);
  }
  return bad;
}

/** A fingerprint of the whole data dir (journal included), for "emitted nothing". */
function dataFingerprint(cwd: string): string {
  const h = createHash("sha256");
  for (const dir of [DATA, META]) {
    for (const f of readdirSync(join(cwd, dir)).sort()) {
      if (dir === DATA && f === "meta") continue;
      h.update(`${dir}/${f}\0`);
      h.update(readFileSync(join(cwd, dir, f)));
    }
  }
  return h.digest("hex");
}

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function probeSource(
  constName: string,
  table: string,
  note?: "text" | "integer",
): string {
  const imports =
    note === "integer" ? "integer, pgTable, text" : "pgTable, text";
  const noteCol = note ? `\n  note: ${note}("note"),` : "";
  return (
    `import { ${imports} } from "drizzle-orm/pg-core";\n\n` +
    `// Throwaway probe table of plugins/upstream/e2e/clone-journey.ts. It exists\n` +
    `// only in that e2e's temp repositories and never lands anywhere else.\n` +
    `export const ${constName} = pgTable("${table}", {\n` +
    `  id: text("id").primaryKey(),${noteCol}\n` +
    `});\n`
  );
}

// --- landing: the real push -------------------------------------------------

/**
 * `./singularity push` of `branch` from the clone's worktree — after asserting
 * that the repository it will land on is this fixture's, under the temp dir.
 * `push` makes the same check against its own checkout; this one also pins it
 * to the temp dir, so a fixture wired to the wrong repository fails here.
 */
async function push(ctx: Ctx, branch: string): Promise<SpawnResult> {
  const current = await git(ctx.cloneWt, "rev-parse", "--abbrev-ref", "HEAD");
  if (current !== branch) {
    throw new HarnessError(
      `expected ${ctx.cloneWt} on ${branch}, found ${current}`,
    );
  }
  const tmp = `${realpathSync(ctx.tmp)}/`;
  const commonDir = realpathSync(
    await git(
      ctx.cloneWt,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ),
  );
  const mainWorktree = (
    await git(ctx.cloneWt, "worktree", "list", "--porcelain")
  )
    .split("\n")[0]!
    .replace(/^worktree /, "");
  if (
    !commonDir.startsWith(tmp) ||
    !realpathSync(mainWorktree).startsWith(tmp)
  ) {
    throw new HarnessError(
      `refusing to push: ${branch} would land on ${mainWorktree} (${commonDir}), outside ${tmp}`,
    );
  }
  return await cli(ctx, ctx.cloneWt, ["push"], PUSH_TIMEOUT_MS);
}

/** This repository's trunk refs at the start of the run, to prove none of the fixture reached them. */
async function realTrunk(source: string): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  for (const ref of ["refs/heads/main", "refs/remotes/origin/main"]) {
    const r = await gitRaw(source, ["rev-parse", "--verify", "-q", ref]);
    if (r.exitCode === 0) refs.set(ref, r.stdout.trim());
  }
  return refs;
}

/**
 * Commits on this repository's trunk since `start` that touch the fixture's
 * probe files — which exist only in the temp repositories, so any such commit
 * came from this run. A provenance check, not "the ref did not move": other
 * agents advance the real `main` while a run is going.
 */
async function fixtureCommitsOnTrunk(
  source: string,
  start: Map<string, string>,
): Promise<string[]> {
  const found: string[] = [];
  for (const [ref, sha] of start) {
    const out = await git(
      source,
      "log",
      "--format=%h %s",
      `${sha}..${ref}`,
      "--",
      UPSTREAM_PROBE,
      CLONE_PROBE,
    );
    for (const line of out.split("\n").filter(Boolean))
      found.push(`${ref}: ${line}`);
  }
  return found;
}

async function commitAll(wt: string, message: string): Promise<void> {
  await git(wt, "add", "-A");
  await git(wt, "commit", "-q", "-m", message);
}

// --- fixture ------------------------------------------------------------------

/**
 * Bring `upWt` (on upstream's `main`) to the SOURCE checkout's working-tree
 * state: tracked changes via a binary diff, untracked (not ignored) files
 * copied, committed as one overlay commit.
 */
async function overlaySourceWorkingTree(ctx: Ctx): Promise<number> {
  const diff = await spawnCaptured(["git", "diff", "HEAD", "--binary"], {
    cwd: ctx.source,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (diff.exitCode !== 0)
    throw new HarnessError(`git diff HEAD: ${diff.stderr}`);
  if (diff.stdout.trim()) {
    const patch = join(ctx.tmp, "overlay.patch");
    writeFileSync(patch, diff.stdoutBytes);
    await git(ctx.upWt, "apply", "--binary", patch);
  }
  const untracked = (
    await spawnCaptured(
      ["git", "ls-files", "--others", "--exclude-standard", "-z"],
      {
        cwd: ctx.source,
        timeoutMs: GIT_TIMEOUT_MS,
      },
    )
  ).stdout
    .split("\0")
    .filter(Boolean);
  for (const rel of untracked) {
    mkdirSync(dirname(join(ctx.upWt, rel)), { recursive: true });
    cpSync(join(ctx.source, rel), join(ctx.upWt, rel));
  }
  const changed = (await git(ctx.upWt, "status", "--porcelain"))
    .split("\n")
    .filter(Boolean).length;
  if (changed > 0)
    await commitAll(ctx.upWt, "e2e: overlay the source working tree");
  return changed;
}

/** The three merge drivers `build` registers (register-merge-drivers.ts). */
async function registerMergeDrivers(repo: string): Promise<void> {
  for (const name of [
    "regen-generated",
    "regen-claudemd",
    "regen-migrations",
  ]) {
    await git(
      repo,
      "config",
      "--local",
      `merge.${name}.driver`,
      `plugins/framework/plugins/cli/scripts/${name}.sh %O %A %B %P`,
    );
  }
}

/**
 * The first CLI call in a fresh worktree installs its dependencies. Done once,
 * up front, so the install's time is not charged to an assertion — and so a
 * lockfile the install rewrote is caught here, as the fixture fault it is,
 * rather than read later as a dirty tree by `upstream merge`.
 */
async function warm(ctx: Ctx, wt: string): Promise<void> {
  const r = await cli(ctx, wt, ["check", "--list"]);
  if (r.exitCode !== 0)
    throw new HarnessError(`warm-up failed in ${wt}:${tail(r)}`);
  const dirty = await git(wt, "status", "--porcelain");
  if (dirty)
    throw new HarnessError(`the dependency install dirtied ${wt}:\n${dirty}`);
}

async function setUp(ctx: Ctx, pristine: boolean): Promise<void> {
  // upstream: this checkout's objects, its HEAD as `main`, no remote.
  await git(
    ctx.tmp,
    "clone",
    "-q",
    "--shared",
    "--no-checkout",
    ctx.source,
    ctx.upstream,
  );
  const head = await git(ctx.source, "rev-parse", "HEAD");
  await git(ctx.upstream, "checkout", "-q", "-f", "-B", "main", head);
  await git(ctx.upstream, "remote", "remove", "origin");
  for (const b of (
    await git(
      ctx.upstream,
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    )
  )
    .split("\n")
    .filter((b) => b && b !== "main")) {
    await git(ctx.upstream, "branch", "-q", "-D", b);
  }
  await git(ctx.upstream, "config", "--local", "user.name", "upstream");
  await git(
    ctx.upstream,
    "config",
    "--local",
    "user.email",
    "upstream@e2e.invalid",
  );

  if (pristine) {
    console.log(
      `  --pristine: upstream main = ${head.slice(0, 10)} (committed HEAD only)`,
    );
  } else {
    const n = await overlaySourceWorkingTree(ctx);
    console.log(
      `  upstream main = ${head.slice(0, 10)} + ${n} uncommitted path(s) of this checkout`,
    );
  }

  // clone: keeps `origin` — the real-clone shape — and its main checkout on
  // `main`, where push fast-forwards it.
  await git(ctx.tmp, "clone", "-q", ctx.upstream, ctx.clone);
  await git(ctx.clone, "config", "--local", "user.name", "clone");
  await git(ctx.clone, "config", "--local", "user.email", "clone@e2e.invalid");
  await registerMergeDrivers(ctx.clone);
  await git(
    ctx.clone,
    "worktree",
    "add",
    "-q",
    "--detach",
    ctx.cloneWt,
    "main",
  );

  console.log(
    "  installing dependencies in both worktrees (slow on first run)...",
  );
  await warm(ctx, ctx.upWt);
  await warm(ctx, ctx.cloneWt);
}

// --- the journey ----------------------------------------------------------------

export interface MigrationJourneyOptions {
  tmp: string;
  source: string;
  pristine: boolean;
  check: Check;
}

export async function runMigrationJourney(
  opts: MigrationJourneyOptions,
): Promise<void> {
  const id = randomBytes(3).toString("hex");
  // Basenames are the checkouts' namespaces (`checkoutRef`), so each is unique
  // to the run. Their data dirs are left to the worktree reaper, which reclaims
  // a namespace a day after its stamped checkout is gone.
  const upstream = join(opts.tmp, `e2e-cj-${id}-up`);
  const ctx: Ctx = {
    tmp: opts.tmp,
    source: opts.source,
    upstream,
    clone: join(opts.tmp, `e2e-cj-${id}-clone`),
    upWt: upstream,
    cloneWt: join(opts.tmp, `e2e-cj-${id}-clone-wt`),
    logDir: join(opts.tmp, "logs"),
    check: opts.check,
    cliSeq: 0,
  };
  mkdirSync(ctx.logDir, { recursive: true });
  const { check } = ctx;
  const trunk = await realTrunk(ctx.source);
  try {
    await journey(ctx, opts.pristine);
  } catch (err) {
    if (!(err instanceof HarnessError)) throw err;
    check("the migration journey's fixture held", false, err.message);
  } finally {
    console.log(`  (CLI logs: ${ctx.logDir})`);
    const leaked = await fixtureCommitsOnTrunk(ctx.source, trunk);
    check(
      "no commit of the fixture reached this repository's main or origin/main",
      leaked.length === 0,
      `\n      ${leaked.join("\n      ")}`,
    );
  }
}

async function journey(ctx: Ctx, pristine: boolean): Promise<void> {
  const { check, upWt, cloneWt } = ctx;

  console.log("\nMigrations — fixture (a copy of this tree):");
  await setUp(ctx, pristine);
  const base = await git(cloneWt, "rev-parse", "main");
  const baseFiles = await filesAt(cloneWt, base);

  const target = await resolvePublishTarget(cloneWt);
  check(
    "the clone publishes nowhere (origin is a directory), its remote still named origin",
    target.kind === "local" &&
      target.reason.kind === "filesystem-remote" &&
      (await git(cloneWt, "remote")) === "origin",
    JSON.stringify(target),
  );

  // --- 2. upstream moves: its own schema migration, on its main.
  console.log("\nMigrations 2 — upstream adds a table:");
  write(upWt, UPSTREAM_PROBE, probeSource("e2eUpstreamProbe", UPSTREAM_TABLE));
  const upGen = await cli(ctx, upWt, [
    "regen-migrations",
    "--name",
    "e2e_upstream",
  ]);
  if (upGen.exitCode !== 0) {
    throw new HarnessError(`upstream's generate failed:${tail(upGen)}`);
  }
  await commitAll(upWt, "upstream: e2e_upstream_probe");
  const upMain = await filesAt(upWt, "main");
  const upstreamPublished = added(baseFiles, upMain);
  check(
    "upstream published exactly one schema migration (one .sql added, the tip snapshot rewritten)",
    sqlOf(upstreamPublished).length === 1 &&
      upstreamPublished.size === 1 &&
      retipped(baseFiles, upMain),
    [...upstreamPublished.keys()].map(basename).join(", "),
  );

  // --- 3. the clone's own work, landed on its local main.
  console.log("\nMigrations 3 — the clone lands its own table:");
  await git(cloneWt, "checkout", "-q", "-b", "clone-own", "main");
  write(cloneWt, CLONE_PROBE, probeSource("e2eCloneProbe", "e2e_clone_probe"));
  const ownGen = await cli(ctx, cloneWt, [
    "regen-migrations",
    "--name",
    "e2e_clone",
  ]);
  if (ownGen.exitCode !== 0)
    throw new HarnessError(`clone's generate failed:${tail(ownGen)}`);
  await commitAll(cloneWt, "clone: e2e_clone_probe");
  const own = await push(ctx, "clone-own");
  if (own.exitCode !== 0)
    throw new HarnessError(`clone-own's push failed:${tail(own)}`);
  const cloneMain = await filesAt(cloneWt, "main");
  const cloneLanded = added(baseFiles, cloneMain);
  check(
    "exactly one clone schema migration landed on local main (one .sql added, the tip snapshot rewritten)",
    sqlOf(cloneLanded).length === 1 &&
      cloneLanded.size === 1 &&
      retipped(baseFiles, cloneMain),
    [...cloneLanded.keys()].map(basename).join(", "),
  );
  console.log(`    landed: ${sqlOf(cloneLanded).map(basename).join(", ")}`);

  // --- 4. Problem 1: a second push, with no migration of its own.
  console.log(
    "\nMigrations 4 — a second clone push, no migration in it (Problem 1):",
  );
  await git(cloneWt, "checkout", "-q", "-b", "clone-second", "main");
  write(cloneWt, "e2e-clone-journey.txt", "unrelated work\n");
  await commitAll(cloneWt, "clone: unrelated work");
  const mainBefore = await git(cloneWt, "rev-parse", "main");
  const second = await push(ctx, "clone-second");
  check("its push succeeds", second.exitCode === 0, tail(second));
  // Measured on what push LANDED. A regression lands the rename (as it would
  // for a user), so step 5 then starts from the renamed main and fails too —
  // read the first failure, not the cascade.
  const touched = (
    await git(cloneWt, "diff", "--name-status", mainBefore, "main", "--", DATA)
  )
    .split("\n")
    .filter((l) => /^[DR]/.test(l));
  check(
    "it deletes or renames no migration already on local main",
    touched.length === 0,
    `\n      ${touched.join("\n      ")}`,
  );
  const lost4 = await notIntact(cloneWt, cloneLanded);
  check(
    "the landed clone migration is byte-identical",
    lost4.length === 0,
    lost4.join(", "),
  );

  // --- 5. Problem 2: take the upstream update.
  console.log(
    "\nMigrations 5 — `upstream merge` brings upstream's migration in (Problem 2):",
  );
  await git(cloneWt, "checkout", "-q", "-f", "-b", "update-1", "main");
  await git(cloneWt, "clean", "-q", "-fd", "--", DATA);
  const merge1 = await cli(ctx, cloneWt, ["upstream", "merge"]);
  if (merge1.exitCode !== 0) {
    throw new HarnessError(
      `upstream merge stopped (expected a clean merge):${tail(merge1)}`,
    );
  }
  const mainFiles = await filesAt(cloneWt, "main");
  const originFiles = await filesAt(cloneWt, "origin/main");
  const gen1 = await cli(ctx, cloneWt, ["regen-migrations"]);
  check(
    "the generate stage succeeds after the merge",
    gen1.exitCode === 0,
    tail(gen1),
  );

  const lost5 = await notIntact(
    cloneWt,
    new Map([...cloneLanded, ...upstreamPublished]),
  );
  check(
    "both sides' published migrations are byte-identical",
    lost5.length === 0,
    lost5.join(", "),
  );
  for (const id of [
    "snapshot-chain-intact",
    "published-migrations-immutable",
    "migration-phases-valid",
  ]) {
    const r = await cli(ctx, cloneWt, ["check", id]);
    check(`\`check ${id}\` passes`, r.exitCode === 0, tail(r));
  }
  const onDisk = await filesOnDisk(cloneWt);
  const fresh = added(new Map([...mainFiles, ...originFiles]), onDisk);
  const freshSql = sqlOf(fresh);
  check(
    "exactly one new migration (and the tip snapshot rewritten as the merge)",
    freshSql.length === 1 &&
      fresh.size === 1 &&
      retipped(mainFiles, onDisk) &&
      retipped(originFiles, onDisk),
    [...fresh.keys()].map(basename).join(", ") || "(none)",
  );
  if (freshSql.length === 1) {
    const sql = readFileSync(join(cloneWt, freshSql[0]!), "utf8");
    const statements = sql
      .split("\n")
      .filter((l) => l.trim() && !l.trimStart().startsWith("--"));
    check(
      "the merge node's SQL is the no-op two-parent snapshot header",
      /^-- singularity:snapshot id=\S+ parents=\S+,\S+$/m.test(sql) &&
        statements.length === 0,
      `\n      ${sql.split("\n").join("\n      ")}`,
    );
  }
  const before = dataFingerprint(cloneWt);
  const gen2 = await cli(ctx, cloneWt, ["regen-migrations"]);
  check(
    "a second generate emits nothing",
    gen2.exitCode === 0 && dataFingerprint(cloneWt) === before,
    gen2.exitCode === 0 ? "the data dir changed" : tail(gen2),
  );

  const step5Failed = !(
    gen1.exitCode === 0 &&
    lost5.length === 0 &&
    freshSql.length === 1 &&
    gen2.exitCode === 0
  );
  if (step5Failed) {
    check(
      "Migrations 6 (a real conflict) ran",
      false,
      "not reached — it needs step 5's merge to land cleanly first",
    );
    return;
  }

  // --- 6. a real conflict: both sides add `note`, with different types.
  console.log(
    "\nMigrations 6 — both sides add column `note`, text vs integer:",
  );
  await git(cloneWt, "add", "-A");
  await git(cloneWt, "commit", "-q", "--amend", "--no-edit");
  const upd = await push(ctx, "update-1");
  if (upd.exitCode !== 0)
    throw new HarnessError(`update-1's push failed:${tail(upd)}`);

  write(
    upWt,
    UPSTREAM_PROBE,
    probeSource("e2eUpstreamProbe", UPSTREAM_TABLE, "text"),
  );
  const upNote = await cli(ctx, upWt, [
    "regen-migrations",
    "--name",
    "e2e_upstream_note",
  ]);
  if (upNote.exitCode !== 0)
    throw new HarnessError(`upstream's note generate failed:${tail(upNote)}`);
  await commitAll(upWt, "upstream: note text");

  await git(cloneWt, "checkout", "-q", "-b", "clone-note", "main");
  write(
    cloneWt,
    UPSTREAM_PROBE,
    probeSource("e2eUpstreamProbe", UPSTREAM_TABLE, "integer"),
  );
  const cloneNote = await cli(ctx, cloneWt, [
    "regen-migrations",
    "--name",
    "e2e_clone_note",
  ]);
  if (cloneNote.exitCode !== 0)
    throw new HarnessError(`clone's note generate failed:${tail(cloneNote)}`);
  await commitAll(cloneWt, "clone: note integer");
  const noteLand = await push(ctx, "clone-note");
  if (noteLand.exitCode !== 0)
    throw new HarnessError(`clone-note's push failed:${tail(noteLand)}`);

  await git(cloneWt, "checkout", "-q", "-b", "update-2", "main");
  const merge2 = await cli(ctx, cloneWt, ["upstream", "merge"]);
  if (merge2.exitCode !== 0) {
    // The schema SOURCE conflicts textually; the user keeps their own side,
    // which is what leaves the two snapshots disagreeing.
    const unmerged = (
      await git(cloneWt, "diff", "--name-only", "--diff-filter=U")
    )
      .split("\n")
      .filter(Boolean);
    if (unmerged.length !== 1 || unmerged[0] !== UPSTREAM_PROBE) {
      throw new HarnessError(
        `unexpected conflicts: ${unmerged.join(", ")}${tail(merge2)}`,
      );
    }
    await git(cloneWt, "checkout", "--ours", "--", UPSTREAM_PROBE);
    await git(cloneWt, "add", "--", UPSTREAM_PROBE);
    const cont = await cli(ctx, cloneWt, ["upstream", "merge", "--continue"]);
    if (cont.exitCode !== 0)
      throw new HarnessError(`merge --continue failed:${tail(cont)}`);
  }
  const conflict = await cli(ctx, cloneWt, ["regen-migrations"]);
  const out = `${conflict.stdout}\n${conflict.stderr}`;
  check(
    "the generate stage fails on the conflict",
    conflict.exitCode !== 0,
    tail(conflict),
  );
  check(
    `it names ${UPSTREAM_TABLE}'s columns.note.type`,
    out.includes(UPSTREAM_TABLE) && out.includes("columns.note.type"),
    tail(conflict),
  );
}
