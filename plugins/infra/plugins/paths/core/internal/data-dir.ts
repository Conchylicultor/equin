import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { mkdirSync, type Stats } from "node:fs";
import { mkdir, rename, symlink } from "node:fs/promises";
import {
  envName,
  readEnv,
  setEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { lstat, stat, statSync } from "@plugins/packages/plugins/timed-fs/core";
import { dirname, join, relative, sep } from "node:path";
// Relative sibling import: this file lives INSIDE the `paths` plugin, so the
// `@plugins/infra/plugins/paths/core` alias would cycle back through the barrel
// that re-exports it.
import type { LogClaim } from "./log-claims";
import { isHostSingleton, isRelease, resolveDataRoot } from "./paths";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";

// The declared-directory registry for `~/.equin/`.
//
// The root used to be a shared mutable namespace with no owner and no reader:
// `EQUIN_DIR` was a plain string and ~37 call sites across ~30 plugins
// wrote `join(EQUIN_DIR, "<whatever>")`. Nothing ever read the directory
// as a whole, so nine orphaned entries (~1 GB) accumulated with zero references
// left in the repo, ten `<name>-slots` dirs were minted by ONE primitive, and
// ~7 GB of pure cache sat indistinguishable from the only copy of a secret.
//
// `defineDataDir` makes each directory a declaration with an owner, a purpose
// and a reclaim policy, keyed under a CLOSED set of top-level kinds. The
// registry is then enumerable, which is what lets `paths:no-undeclared-data-dirs`
// diff the real filesystem against it and fail on the next orphan on the day it
// appears rather than a year later.
//
// Node-only (`node:fs` + `node:path`), like the rest of this plugin's `core/`:
// runtime-neutral, never importable from `web/`.

/**
 * The closed set of top-level kinds under the data root. Everything the app
 * writes is exactly one of these, and the kind is the answer to "may I delete
 * this whole subtree?" that `du` can never give you.
 *
 * - `apps` — user content owned by one app: exactly ONE dir per app,
 *   `apps/<app>/`, minted only by {@link defineAppDataDir} from the app's root
 *   plugin. Everything the app (and each of its sub-plugins) keeps durably
 *   lives inside it, in a `subdir()` area — never in a second `apps/*` dir, and
 *   never in a `state/*` dir beside it (`paths:app-data-dirs` enforces both).
 * - `worktrees` — the existing per-worktree layout, unchanged
 * - `services` — long-lived service state (postgres, sockets, …)
 * - `state` — durable app state that is the only copy (config, secrets, releases)
 * - `cache` — rebuilt on demand; the whole kind is reclaimable wholesale
 * - `locks` — cross-process lock/slot files; reclaimable once nothing is running
 * - `logs` — append-only observability output
 * - `deprecated` — quarantine for entries with no live owner
 *
 * Adding a kind is a reviewed edit to this array — that is the point. A kind is
 * a reclaim class, not a folder someone felt like making.
 */
export const DATA_DIR_KINDS = [
  "apps",
  "worktrees",
  "services",
  "state",
  "cache",
  "locks",
  "logs",
  "deprecated",
] as const;

export type DataDirKind = (typeof DATA_DIR_KINDS)[number];

/**
 * What it costs to delete this directory — the fact a size listing cannot carry.
 *
 * A discriminated union rather than a boolean because the interesting cases are
 * not "safe / unsafe": a slot dir is safe once the cluster stops but not while
 * it runs, and a release-bundle dir is safe for every group except the newest
 * few. Collapsing those into one flag is how a cache becomes indistinguishable
 * from the only copy of something.
 */
export type ReclaimPolicy =
  /** Rebuilt on demand; `rm -rf` costs nothing but a re-derivation. */
  | { kind: "safe" }
  /** Safe once the owning service stops — live handles/locks live here. */
  | { kind: "restart" }
  /** The only copy: user content, secrets. Never reclaim. */
  | { kind: "never"; reason: string }
  /** Keep the newest `keep` run-id groups; older groups are reclaimable. */
  | { kind: "keep"; keep: number }
  /** Reclaimable once older than `ttlDays`. */
  | { kind: "ttl"; ttlDays: number };

export interface DataDirSpec {
  kind: DataDirKind;
  /**
   * The ONE caller-supplied path segment. Must match `/^[a-z0-9][a-z0-9-]*$/`,
   * so a name can never contain a separator and mint a nested namespace behind
   * the registry's back.
   */
  name: string;
  /** Owning plugin path, e.g. `"framework/tooling/checks"`. */
  owner: string;
  /** What lives here, in one line — rendered by the audit surface. */
  description: string;
  reclaim: ReclaimPolicy;
  /**
   * Physically NOT under `<kind>/`. Set ONLY for grandfathered entries whose
   * move would require stopping something that cannot be stopped cheaply (the
   * live services: postgres, sockets, zero, node). Carries the reason, and the
   * undeclared-data-dirs check honours it instead of demanding the entry move.
   *
   * `path` is **relative to the data root**, never absolute. Two reasons, both
   * load-bearing: an absolute literal would be frozen at module eval and so
   * would not follow `EQUIN_DIR` (see {@link dataRoot}), and it would
   * have to spell out the home directory, which `paths:no-hardcoded-paths`
   * bans outright.
   */
  legacyLocation?: { path: string; reason: string };
  /**
   * Where this directory's bytes USED to live, so an existing root is moved
   * rather than silently abandoned. See {@link MovedFrom} for the semantics and
   * why this is a declaration rather than a one-off migration script.
   */
  movedFrom?: readonly MovedFrom[];
  /**
   * The log files this directory holds, each family with what keeps it finite
   * (see `./log-claims.ts`). `paths:logs-claimed` fails on a `*.log` /
   * `*.jsonl` file in a `logs` or `services` dir — or in any dir that declares
   * claims — that no claim matches.
   */
  logs?: readonly LogClaim[];
}

/**
 * A declared directory, spelled the way `getDataDirs()` keys it: `${kind}/${name}`.
 */
export type DataDirRef = `${DataDirKind}/${string}`;

/**
 * One earlier location of a declared directory's bytes.
 *
 * `from` is the old `${kind}/${name}`. `to` is the ONE-segment area inside this
 * directory those bytes now occupy — the same name a consumer passes to
 * `subdir()` — or absent when the whole directory moved. So
 * `{ from: "apps/attachments" }` on `state/attachments` says the whole dir
 * moved, and `{ from: "apps/wallpaper", to: "wallpaper" }` on `apps/desktop`
 * says the old dir became the `wallpaper` area of the new one.
 *
 * **The declaration does the move, not a script.** Each process tree settles
 * every declared move at its entry point, before anything reads a path
 * (`settleDeclaredDataDirMoves`: a backend's boot, before it listens; an `exec`
 * boot; a check that reads every dir), and every read of `.path`, `.file()`,
 * `.ensure()` and a `subdir()` handle resolves through what it found — no
 * disk, on any thread — so no consumer can read the new location while the
 * bytes still sit at the old one:
 *
 * - **Settled** — `from` is absent or is a symlink: the new location.
 * - **Pending** — `from` is a real directory and the destination is absent. The
 *   host singleton running merged code (see `mayMoveSharedData`) performs the
 *   move at its boot: `rename` (atomic), then a relative symlink at `from`.
 *   Every other process resolves to the OLD location and moves nothing — and
 *   keeps reaching the bytes once main moves them, through that symlink.
 * - **Conflict** — `from` is a real directory AND the destination exists: a
 *   split copy. Every read of that directory throws, naming both paths. Either
 *   side may hold the only copy of something, and there is no automatic merge
 *   that could be right.
 *
 * A process whose tree settled nothing throws on its first read of a moved
 * dir (`DataDirMovesUndeclaredError`), rather than decide on whatever thread
 * asked.
 *
 * Why a declaration and not another `LEGACY_LAYOUT` row: that table is
 * top-level only, self-liquidating ("nothing may be added"), and its script
 * refuses to run while a gateway is alive — it was built for one flag day, not
 * for the next time an owner relocates a directory. A move recorded on the
 * declaration itself travels with the code that needs it, runs on every root
 * the code ever meets (dev, a release, a fresh install), and is deleted with a
 * one-line edit once every live checkout reads the new spot.
 *
 * Why only the host singleton moves: building or testing an unmerged branch
 * must never mutate the root every other checkout shares. The move lands when
 * main restarts on the merged code, and until then the branch's own processes
 * read the old bytes in place.
 *
 * Why the symlink: an older checkout still running pre-move code keeps
 * resolving the old path, and the link makes that old path the SAME bytes
 * rather than a fresh empty directory it would silently start filling.
 */
export interface MovedFrom {
  readonly from: DataDirRef;
  /** A `subdir()` area of this directory; absent = the whole directory moved. */
  readonly to?: string;
}

/**
 * What `defineDataDir` accepts: a spec whose kind is anything BUT `apps`.
 *
 * An `apps/*` directory can only be spelled from an app identity, through
 * {@link defineAppDataDir} — so `defineDataDir({ kind: "apps", … })` is a type
 * error rather than a review comment. The stored {@link DataDirSpec} keeps the
 * full kind, so the registry, the manifest and the audit read one shape.
 */
export type DataDirInput = Omit<DataDirSpec, "kind"> & {
  kind: Exclude<DataDirKind, "apps">;
};

/**
 * An area INSIDE a declared directory, from `DataDir.subdir(name)`.
 *
 * Not registered, and not a second declaration: it is a named corner of one.
 * This is how a sub-plugin gets space of its own in its app's single data dir
 * (`desktopDir.subdir("wallpaper")`) without minting a directory the registry
 * would have to track and the audit would have to explain. The area name obeys
 * the data-dir name rule — one lowercase segment — for the same reason: it
 * becomes a literal directory name on disk.
 */
export interface DataDirArea {
  /** The absolute directory. A GETTER, like `DataDir.path`. */
  readonly path: AppPath;
  /** A path INSIDE this area. */
  file(...segments: string[]): AppPath;
  /** `mkdir -p` the area, and return its path. See {@link DataDir.ensure}. */
  ensure(): Promise<AppPath>;
  /** {@link ensure}, holding the thread: for a process that may block (a CLI, a check, a script). */
  ensureSync(): AppPath;
}

export interface DataDir {
  readonly spec: DataDirSpec;
  /**
   * The absolute directory. A GETTER, resolved on every read — never a value
   * frozen at declaration time. See {@link dataRoot}.
   */
  readonly path: AppPath;
  /** A path INSIDE this directory. The only sanctioned way to name a child. */
  file(...segments: string[]): AppPath;
  /**
   * `mkdir -p` the directory, and return its path — without holding the
   * thread, so a backend can call it on every write.
   */
  ensure(): Promise<AppPath>;
  /**
   * {@link ensure}, holding the thread: for a process that may block (a CLI,
   * a check, a script, a `bin/` entry before it serves). A backend cannot call
   * it (`blocking-fs/no-sync-fs`).
   */
  ensureSync(): AppPath;
  /**
   * A named area inside this directory — ONE lowercase segment, validated like
   * a data-dir name. See {@link DataDirArea}.
   */
  subdir(name: string): DataDirArea;
}

/**
 * The one thing {@link defineAppDataDir} needs from an app: its id.
 *
 * Structural on purpose, so an `AppRef` satisfies it as-is and this plugin does
 * not grow an `infra/paths → primitives/pane` edge. What makes the id HONEST —
 * that `apps/<id>` really is declared from `plugins/apps/plugins/<id>` — is
 * `paths:app-data-dirs`, which pairs every declaration with the plugin that
 * made it.
 */
export interface AppIdentity {
  readonly id: string;
}

// A name is ONE path segment, lowercase-kebab. Same regex (and same
// throw-on-violation discipline) as `createHostSemaphore`'s pool name, since
// both end up as a literal directory name on disk.
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Why every `apps/*` dir is `reclaim: never` — fixed, not per-app. */
const APP_DIR_RECLAIM_REASON =
  "an app's data dir holds the only copy of its users' content";

/**
 * The data root ITSELF.
 *
 * Its ONE legitimate use is handing the root to a child process as its
 * `EQUIN_DIR` (the gateway spawn, a release launch, a remote deploy's
 * env line). `join(dataRoot(), …)` is exactly what `defineDataDir` exists to
 * replace — a joined root is an undeclared directory, which is the failure mode
 * this whole registry is here to make impossible.
 *
 * A FUNCTION, not a const, and its result must not be cached by a caller:
 * `EQUIN_DIR` is env-overridable and the release launcher sets it before
 * importing anything path-dependent, so a value frozen at module eval captures
 * whatever the environment said when that module was FIRST imported. This is
 * the same reasoning that made `webDistDir()` a function — see its docblock in
 * `./paths.ts`; the const form there is what once made a release report a null
 * build id. `defineDataDir` runs at consumer module eval, which is earlier
 * still, so freezing here would be strictly worse.
 */
export function dataRoot(): AppPath {
  return resolveDataRoot();
}

/**
 * Where a declared directory — or a file inside it — sits RELATIVE to the data
 * root: `relativeToDataRoot(gatewayLocks, "gateway.pid")` is
 * `"locks/gateway/gateway.pid"`.
 *
 * For the callers that must name a declared location under a root that is NOT
 * this process's own: teardown killing a release preview's gateway under its
 * `/tmp/sgp-XXXXXX` data dir, a release bundle seeding config into a freshly
 * installed app's data dir, the asset-mirror seed. They cannot read `.path`,
 * which resolves against THIS process's root — but they must not spell the
 * location a second time either, because a hand-written copy goes on naming the
 * old spot after a layout change moves the real one. That failure is silent by
 * construction: the seed lands where nothing reads it, the preview's gateway
 * becomes un-killable.
 *
 * Takes a {@link DataDir}, not a path, so it cannot be used to relativise an
 * arbitrary string — the only thing worth expressing relative to the root is
 * something the registry already owns. This replaced three hand-written copies
 * of `relative(dataRoot(), …)`, one per calling plugin, which were the only
 * recurring reason a file outside this plugin called `dataRoot()` at all.
 */
export function relativeToDataRoot(
  dir: DataDir,
  ...segments: string[]
): string {
  return relative(dataRoot(), dir.file(...segments));
}

/**
 * `mkdir -p` a directory a declaration resolved to, and return it — the ONE
 * implementation behind both `DataDir.ensure()` and `DataDirArea.ensure()`
 * (and their `ensureSync()` twins), so the guard below cannot exist on one and
 * be forgotten on the other.
 *
 * `what` names the thing being ensured in the error (`cache/check (owner …)`,
 * or an area of one).
 */
async function ensureDirectory(path: AppPath, what: string): Promise<AppPath> {
  // `mkdir -p` first: on an existing directory it is one syscall that
  // succeeds, and on a path that is a FILE it fails with EEXIST (or ENOTDIR on
  // a file higher up) — only then is the stat worth paying, to explain it.
  try {
    await mkdir(path, { recursive: true });
  } catch (err) {
    const code = errnoCode(err);
    if (code !== "EEXIST" && code !== "ENOTDIR") throw err;
    const existing = await stat(path).catch((statErr: unknown) => {
      if (errnoCode(statErr) === "ENOENT" || errnoCode(statErr) === "ENOTDIR")
        return undefined;
      throw statErr;
    });
    if (existing === undefined || existing.isDirectory()) throw err;
    throw notADirectoryError(path, what);
  }
  return path;
}

/** {@link ensureDirectory}, holding the thread. */
function ensureDirectorySync(path: AppPath, what: string): AppPath {
  const existing = statSync(path, { throwIfNoEntry: false });
  if (existing && !existing.isDirectory()) throw notADirectoryError(path, what);
  // A genuinely unwritable data root is a real fault and should surface
  // loudly rather than be swallowed into a silent no-write.
  mkdirSync(path, { recursive: true });
  return path;
}

// A `DataDir` names a DIRECTORY. Several entries at the root are loose FILES
// today (`duress.latch`, `gateway.pid`, `push-holder.json`, the `*.jsonl`
// sinks), and pointing a declaration's `legacyLocation` at one of those is a
// trap: `mkdir` would try to create a DIRECTORY where the file is, and the
// owner's next write would fail with EISDIR — far from the declaration that
// caused it. Such an entry belongs INSIDE a declared dir, reached via
// `file()`; say so here rather than let the raw EEXIST surface with no
// explanation of what to do about it.
function notADirectoryError(path: AppPath, what: string): Error {
  return new Error(
    `[data-dir] ${what} resolves to ${path}, which exists and is NOT a directory. ` +
      `A DataDir (and each of its subdir() areas) names a directory; a single file belongs inside one — declare the containing dir and reach the file with .file("<name>").`,
  );
}

function assertAreaName(name: string, what: string): void {
  if (NAME_RE.test(name)) return;
  throw new Error(
    `[data-dir] ${what} must match ${String(NAME_RE)}, got ${JSON.stringify(name)}. ` +
      `An area is ONE lowercase path segment inside its data dir — reach deeper paths with .file(…).`,
  );
}

function makeDataDir(spec: DataDirSpec): DataDir {
  const key = `${spec.kind}/${spec.name}`;
  const moves = spec.movedFrom ?? [];

  // Resolved per call, never closed over as a value — see `dataRoot()`.
  const home = (): AppPath =>
    spec.legacyLocation
      ? joinAppPath(dataRoot(), spec.legacyLocation.path)
      : joinAppPath(dataRoot(), spec.kind, spec.name);

  // Every path this declaration hands out goes through here, so a move is
  // honoured by `.path`, `.file()`, `.ensure()` and every `subdir()` handle
  // alike — there is no accessor that could read the new location early. It
  // reads the moves' DECLARATION, never the disk (see `settleDataDirMoves`).
  const resolveIn = (segments: readonly string[]): AppPath => {
    const base = home();
    if (moves.length === 0) return joinAppPath(base, ...segments);

    // The area a path falls in is its FIRST segment, normalised — so
    // `file("wallpaper", "a.jpg")` and `file("wallpaper/a.jpg")` agree.
    const rel = join(".", ...segments);
    const parts = rel === "." ? [] : rel.split(sep).filter((p) => p !== "");
    const move =
      moves.find((m) => m.to !== undefined && m.to === parts[0]) ??
      moves.find((m) => m.to === undefined);
    if (!move) return joinAppPath(base, ...segments);

    const dest = move.to === undefined ? base : joinAppPath(base, move.to);
    const from = joinAppPath(dataRoot(), move.from);
    if (declaredMoveSide(key, move, from, dest) === "new")
      return joinAppPath(base, ...segments);
    // Still at the old location: re-base what lies below the moved area.
    const below = move.to === undefined ? parts : parts.slice(1);
    return joinAppPath(from, ...below);
  };

  const what = `${key} (owner ${spec.owner})`;
  const areaWhat = (name: string): string =>
    `${key} area "${name}" (owner ${spec.owner})`;

  const area = (name: string): DataDirArea => {
    assertAreaName(name, `${key}.subdir() name`);
    return {
      get path(): AppPath {
        return resolveIn([name]);
      },
      file(...segments: string[]): AppPath {
        return resolveIn([name, ...segments]);
      },
      async ensure(): Promise<AppPath> {
        return ensureDirectory(resolveIn([name]), areaWhat(name));
      },
      ensureSync(): AppPath {
        return ensureDirectorySync(resolveIn([name]), areaWhat(name));
      },
    };
  };

  return {
    spec,
    get path(): AppPath {
      return resolveIn([]);
    },
    file(...segments: string[]): AppPath {
      return resolveIn(segments);
    },
    async ensure(): Promise<AppPath> {
      return ensureDirectory(resolveIn([]), what);
    },
    ensureSync(): AppPath {
      return ensureDirectorySync(resolveIn([]), what);
    },
    subdir: area,
  };
}

// ── movedFrom: moving a declared directory ──────────────────────────────────
//
// See `MovedFrom` for what a move means and why it is a declaration. What
// follows is the mechanism, in two halves that never meet on one thread:
//
// - SETTLING (`settleDataDirMoves`, async) inspects both locations of every
//   declared move and — only in the one process allowed to, a backend's boot
//   before it listens — performs a pending one. It DECLARES what it found, for
//   this process and every process it starts (`EQUIN_DATA_DIR_MOVES`), the way
//   a tree's root declares the data root's layout.
// - RESOLVING (every getter) reads that declaration and nothing else: no disk,
//   on any thread. A process whose tree declared nothing throws
//   (`DataDirMovesUndeclaredError`) rather than decide on the spot.

/** Where a move stands on one data root. Never a boolean: "pending" and "conflict" demand opposite things. */
type MoveState = "settled" | "pending" | "conflict";

const MOVE_STATES: ReadonlySet<string> = new Set<MoveState>([
  "settled",
  "pending",
  "conflict",
]);

/**
 * What a process's tree found about the declared moves: the data root it
 * inspected, and each move's state there, keyed by its `from` ref. Carried in
 * the environment as JSON, so a backend's workers and the children it spawns
 * resolve without reading the disk either.
 *
 * Keyed by ROOT: a process that repoints `EQUIN_DIR` (a test, the release
 * launcher) holds no declaration for the new root, rather than trusting the old
 * one's answer.
 */
interface MovesDeclaration {
  readonly root: string;
  readonly moves: Readonly<Record<string, MoveState>>;
}

function parseMovesDeclaration(raw: string): MovesDeclaration {
  const malformed = (): Error =>
    new Error(
      `[data-dir] ${envName("DATA_DIR_MOVES")} is not a moves declaration: ${raw}. ` +
        `It is written only by settleDataDirMoves(); something else set it.`,
    );
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) throw malformed();
  const { root, moves } = value as { root?: unknown; moves?: unknown };
  if (typeof root !== "string" || typeof moves !== "object" || moves === null)
    throw malformed();
  for (const state of Object.values(moves))
    if (typeof state !== "string" || !MOVE_STATES.has(state)) throw malformed();
  return { root, moves: moves as Record<string, MoveState> };
}

/** The last declaration parsed, by its raw text: the environment is read on every resolution, parsed once. */
let parsedDeclaration: { raw: string; value: MovesDeclaration } | undefined;

/** This process's declared move states for the CURRENT data root, or undefined when its tree declared none for it. */
function declaredMoves(): Readonly<Record<string, MoveState>> | undefined {
  const raw = readEnv("DATA_DIR_MOVES");
  if (raw === undefined) return undefined;
  if (parsedDeclaration?.raw !== raw)
    parsedDeclaration = { raw, value: parseMovesDeclaration(raw) };
  const { root, moves } = parsedDeclaration.value;
  return root === dataRoot() ? moves : undefined;
}

/**
 * A process read a directory that carries a `movedFrom` before anything in its
 * tree settled the moves on its data root. Never decided on the spot: that
 * reads the disk on whatever thread asked, a backend's included. The fix is at
 * the entry point that started the process (`settleDeclaredDataDirMoves()`
 * before it reads), or at the spawner that dropped the variable from its
 * child's environment.
 */
export class DataDirMovesUndeclaredError extends Error {
  constructor(key: string, from: string) {
    super(
      `[data-dir] ${key} records that it moved from ${from}, and nothing in this process's tree settled that move on ` +
        `its data root (pid ${process.pid}, ${process.argv.slice(1, 3).join(" ")}; ${envName("DATA_DIR_MOVES")} ` +
        `carries no answer for ${dataRoot()}). Await settleDeclaredDataDirMoves() at the process's entry point before ` +
        `it reads a path, or pass the spawner's environment on (infra/paths CLAUDE.md, § Moving a declared dir).`,
    );
    this.name = "DataDirMovesUndeclaredError";
  }
}

/**
 * Which side of a move a read lands on, from the declaration alone. Pending
 * reads the OLD location — and keeps reading it once the mover has moved the
 * bytes, through the symlink the move leaves there, so a process that settled
 * before main moved still reads the same bytes.
 */
function declaredMoveSide(
  key: string,
  move: MovedFrom,
  from: AppPath,
  dest: AppPath,
): "new" | "old" {
  const state = declaredMoves()?.[move.from];
  if (state === undefined)
    throw new DataDirMovesUndeclaredError(key, move.from);
  if (state === "conflict") throw splitCopyError(key, from, dest);
  return state === "settled" ? "new" : "old";
}

function errnoCode(err: unknown): string | undefined {
  return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}

/** `lstat`, absent as undefined; any other failure propagates. */
async function lstatOrAbsent(path: AppPath): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return undefined;
    throw err;
  }
}

async function inspectMove(
  from: AppPath,
  dest: AppPath,
  key: string,
): Promise<MoveState> {
  const old = await lstatOrAbsent(from);
  // Absent: moved already (or a fresh root that never had it). A symlink: the
  // shim a previous move planted — the bytes are behind it, at the new spot.
  if (!old || old.isSymbolicLink()) return "settled";
  if (!old.isDirectory())
    throw new Error(
      `[data-dir] ${key} records that it moved from ${from}, but that path is a FILE, not a directory. ` +
        `A movedFrom names a directory whose bytes moved; something else has taken its name. Inspect it by hand.`,
    );
  return (await lstatOrAbsent(dest)) ? "conflict" : "pending";
}

function splitCopyError(key: string, from: AppPath, dest: AppPath): Error {
  return new Error(
    `[data-dir] SPLIT COPY: ${key} records that ${from} moved to ${dest}, and BOTH exist as real directories. ` +
      `Either side may hold the only copy of something, so nothing is chosen automatically and every read of ${key} fails until a human merges them: ` +
      `move whatever only ${from} holds into ${dest}, then replace ${from} with a symlink → ${relative(dirname(from), dest)} ` +
      `so older checkouts keep writing the same bytes.`,
  );
}

/**
 * Settle every move the given declarations carry on the current data root, and
 * declare the outcome for this process and everything it starts — the one call
 * that touches the disk for a move. Asynchronous, so a backend runs it at boot
 * without holding its thread.
 *
 * `perform: true` only from a backend's boot, before it listens: a pending move
 * is then performed — when this process is the one allowed to
 * (`mayMoveSharedData`). Every other caller (a worktree's backend, an `exec`
 * child, a check, a test) only inspects, and resolves a pending move to the old
 * location.
 *
 * A split copy is declared, not thrown: every read of THAT directory fails,
 * naming both paths, and nothing else in the process is held hostage to it.
 */
export async function settleDataDirMoves(
  dirs: Iterable<DataDir>,
  opts: { perform: boolean },
): Promise<void> {
  const root = dataRoot();
  const moves: Record<string, MoveState> = {};
  let mover: boolean | undefined;
  for (const dir of dirs) {
    const key = `${dir.spec.kind}/${dir.spec.name}`;
    for (const move of dir.spec.movedFrom ?? []) {
      const from = joinAppPath(root, move.from);
      const dest = joinAppPath(root, moveDestination(dir.spec, move));
      let state = await inspectMove(from, dest, key);
      if (state === "pending" && opts.perform) {
        mover ??= await thisProcessMayMoveSharedData();
        if (mover) state = await performMove(key, move, from, dest);
      }
      if (state === "conflict")
        console.error(splitCopyError(key, from, dest).message);
      moves[move.from] = state;
    }
  }
  setEnv(
    "DATA_DIR_MOVES",
    JSON.stringify({ root, moves } satisfies MovesDeclaration),
  );
}

/**
 * `rename` is the only errno set a CONCURRENT mover produces: the source is
 * already gone (ENOENT), or it is already the other mover's symlink and the
 * destination is its directory (EISDIR), or the destination already landed
 * (EEXIST / ENOTEMPTY). Anything else is a real fault. Even these are never
 * taken on trust — the move is re-inspected, and only a state that is now
 * settled counts as "someone else won".
 */
const RACE_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "EEXIST",
  "ENOTEMPTY",
  "EISDIR",
]);

/** Perform one pending move; answers where it stands afterwards (settled, or a split copy it found). */
async function performMove(
  key: string,
  move: MovedFrom,
  from: AppPath,
  dest: AppPath,
): Promise<"settled" | "conflict"> {
  // The destination's parent may not exist yet — `apps/desktop` on a root where
  // only `apps/wallpaper` ever did.
  await mkdir(dirname(dest), { recursive: true });
  try {
    // Atomic: at every instant the bytes are at exactly one of the two paths.
    await rename(from, dest);
  } catch (err) {
    const code = errnoCode(err);
    if (code === undefined || !RACE_CODES.has(code)) throw err;
    const now = await inspectMove(from, dest, key);
    if (now !== "pending") return now; // settled: another mover won, it plants the shim
    throw err; // still pending — the error was not a race after all
  }

  // Relative, so the link survives the whole root being moved or restored
  // elsewhere (a backup extracted onto another machine, a release root).
  const target = relative(dirname(from), dest);
  try {
    await symlink(target, from);
  } catch (err) {
    if (errnoCode(err) !== "EEXIST") throw err;
    // Between the rename and here, something put a name back at `from`. A
    // symlink is a concurrent mover's shim and fine; a real directory is
    // pre-move code re-creating the old dir — a split copy in the making.
    if (!(await lstat(from)).isSymbolicLink()) return "conflict";
  }

  console.warn(
    `[data-dir] moved ${move.from} → ${relative(dataRoot(), dest)} (declared movedFrom of ${key}); ` +
      `left a symlink at ${move.from} → ${target} so older checkouts keep reading and writing the same bytes.`,
  );
  return "settled";
}

/**
 * The facts that decide whether a process may move bytes on the shared root.
 * Pure, so the rule is testable without impersonating a backend.
 */
export interface MoverFacts {
  /** `isHostSingleton()`: the main backend, or a release's single backend. */
  hostSingleton: boolean;
  /** `isRelease()`: a compiled release, running against its own data root. */
  release: boolean;
  /** The running code IS the main checkout (its `.git` is a directory, not a worktree's gitdir file). */
  mainCheckout: boolean;
}

/**
 * May a process with these facts perform a pending move?
 *
 * The host singleton, AND running merged code. The second half is not
 * belt-and-braces: a process can read as the host singleton while running an
 * UNMERGED branch — main's backend spawns exec children, and until the runtime
 * namespace became a declared argument every agent CLI, test and hook inherited
 * main's identity through the environment. On `isHostSingleton()` alone such a
 * process would move directories on the root every other checkout shares, which
 * is precisely what a move must never be. Code running from the
 * main checkout is merged code by definition, so that is the half that makes
 * the singleton answer true. A release has no checkout at all (it runs from a
 * compiled binary) and owns its own root, so it qualifies on its own.
 */
export function mayMoveSharedData(facts: MoverFacts): boolean {
  return facts.hostSingleton && (facts.release || facts.mainCheckout);
}

/**
 * Is the code in this process the main checkout? A git linked worktree's `.git`
 * is a FILE (`gitdir: …`); the main checkout's is the repository DIRECTORY.
 */
async function runsFromMainCheckout(): Promise<boolean> {
  return (
    (await lstatOrAbsent(joinAppPath(REPO_ROOT, ".git")))?.isDirectory() ===
    true
  );
}

async function thisProcessMayMoveSharedData(): Promise<boolean> {
  return mayMoveSharedData({
    hostSingleton: isHostSingleton(),
    release: isRelease(),
    mainCheckout: await runsFromMainCheckout(),
  });
}

/**
 * Validate a declaration's `movedFrom` against itself, at declaration time —
 * so a malformed move fails at module eval, naming the owner, rather than on
 * some later read on some machine whose disk happens to exercise it.
 */
function assertMovesWellFormed(spec: DataDirSpec, key: string): void {
  const moves = spec.movedFrom ?? [];
  if (moves.length === 0) return;

  if (spec.legacyLocation)
    throw new Error(
      `[data-dir] ${key} (owner ${spec.owner}) carries both legacyLocation and movedFrom. ` +
        `A grandfathered location is by definition not being moved; drop one of the two.`,
    );

  const areas = new Set<string | undefined>();
  for (const move of moves) {
    const [kind, name, ...rest] = move.from.split("/");
    if (
      !(DATA_DIR_KINDS as readonly string[]).includes(kind ?? "") ||
      name === undefined ||
      !NAME_RE.test(name) ||
      rest.length > 0
    )
      throw new Error(
        `[data-dir] ${key} (owner ${spec.owner}): movedFrom.from must be a "<kind>/<name>" data-dir ref, got ${JSON.stringify(move.from)}.`,
      );
    if (move.from === key)
      throw new Error(
        `[data-dir] ${key} (owner ${spec.owner}) lists itself in movedFrom.`,
      );
    if (move.to !== undefined) assertAreaName(move.to, `${key} movedFrom.to`);
    if (areas.has(move.to))
      throw new Error(
        `[data-dir] ${key} (owner ${spec.owner}) has two movedFrom entries landing on ` +
          `${move.to === undefined ? "the whole directory" : `area "${move.to}"`}; each destination receives exactly one old location.`,
      );
    areas.add(move.to);
  }
  // A whole-dir move and area moves in one declaration would make the areas'
  // old locations depend on whether the whole dir has moved yet. No real move
  // needs it: a dir that moved twice drops the older entry once it settles.
  if (areas.has(undefined) && areas.size > 1)
    throw new Error(
      `[data-dir] ${key} (owner ${spec.owner}) mixes a whole-directory movedFrom with area movedFroms; ` +
        `declare one whole-directory move, or area moves only.`,
    );
}

// `${kind}/${name}` → dir. Module-level ⇒ process-global; populated as a side
// effect of the declaring calls at consumer module eval (each owner's
// `data-dirs/index.ts`, loaded through the `data-dirs` collected dir).
const dataDirs = new Map<string, DataDir>();

/**
 * Every declared `movedFrom.from` → the key of the declaration that claims it.
 * Two declarations claiming one old location would both try to move it; a
 * declared dir that is also some other dir's `from` would be read and moved
 * away at once. Both throw, from whichever declaration arrives second.
 */
const movedFromClaims = new Map<string, string>();

/**
 * The shared tail of both declaring functions: uniqueness, move validation,
 * registration.
 */
function register(spec: DataDirSpec): DataDir {
  const key = `${spec.kind}/${spec.name}`;
  const existing = dataDirs.get(key);
  if (existing) {
    throw new Error(
      `[data-dir] "${key}" is already declared by ${existing.spec.owner} ` +
        `(${existing.spec.description}); a data dir is declared exactly once. ` +
        `Attempted to re-declare it from ${spec.owner}. ` +
        `Two owners claiming one directory is a bug — pick a distinct name, or import the existing declaration.`,
    );
  }
  const claimedBy = movedFromClaims.get(key);
  if (claimedBy !== undefined)
    throw new Error(
      `[data-dir] "${key}" (owner ${spec.owner}) is declared, but ${claimedBy} records that it moved away. ` +
        `A directory cannot both exist and have moved — drop one of the two declarations.`,
    );

  assertMovesWellFormed(spec, key);
  for (const move of spec.movedFrom ?? []) {
    const other = movedFromClaims.get(move.from);
    if (other !== undefined)
      throw new Error(
        `[data-dir] ${key} (owner ${spec.owner}) and ${other} both record that ${move.from} moved to them; an old location moves to exactly one place.`,
      );
    const live = dataDirs.get(move.from);
    if (live)
      throw new Error(
        `[data-dir] ${key} (owner ${spec.owner}) records that ${move.from} moved to it, but ${move.from} is still declared by ${live.spec.owner}. ` +
          `A directory cannot both exist and have moved — delete that declaration.`,
      );
  }
  for (const move of spec.movedFrom ?? []) movedFromClaims.set(move.from, key);

  const dir = makeDataDir(spec);
  dataDirs.set(key, dir);
  return dir;
}

/**
 * Declare a directory under the data root.
 *
 * Mirrors `defineFileSink`'s exactly-once discipline: a directory is declared
 * EXACTLY ONCE, so ANY re-declaration of the same `${kind}/${name}` throws.
 * Deliberately NOT `defineHostPool`'s dedup-if-identical rule — two owners
 * claiming one directory is always a bug, and silently keeping the first
 * declaration would hide precisely the shared-mutable-namespace problem this
 * registry exists to end.
 *
 * Every kind but `apps`: an app's directory comes from {@link defineAppDataDir},
 * and the input type says so. The runtime throw below is the same rule for a
 * caller that got past the type (a cast, plain JS).
 */
export function defineDataDir(spec: DataDirInput): DataDir {
  if ((spec.kind as DataDirKind) === "apps")
    throw new Error(
      `[data-dir] "apps/${spec.name}" (owner ${spec.owner}): an apps/* dir is declared only with ` +
        `defineAppDataDir(<app>, …) from the app's root plugin — plugins/apps/plugins/<app>/data-dirs/index.ts.`,
    );
  if (!NAME_RE.test(spec.name)) {
    throw new Error(
      `[data-dir] name must match ${String(NAME_RE)}, got ${JSON.stringify(spec.name)}. ` +
        `A data-dir name is ONE lowercase path segment — nest by declaring a second dir, not by embedding a separator.`,
    );
  }
  return register(spec);
}

/** `file-explorer` → `fileExplorerDir`: the conventional name of an app's dir constant, for messages. */
function appDirConstName(id: string): string {
  return `${id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())}Dir`;
}

/**
 * Declare an APP's data dir: `apps/<app.id>/`, the one directory that app owns.
 *
 * Everything the app keeps durably — its own content and each of its
 * sub-plugins' — lives inside it, in `subdir()` areas. So there is no `name`
 * (it IS the app id) and no `reclaim` (an app dir holds the only copy of its
 * users' content, always). Re-derivable output still belongs in `cache/`.
 *
 * Called from the app's ROOT plugin — `plugins/apps/plugins/<id>/data-dirs/index.ts`,
 * — and imported from there
 * by the sub-plugins that read it. `paths:app-data-dirs` holds the call site to
 * that, which is what makes the structural `app` parameter honest.
 *
 * A second call for the same app throws with the fix in the message, because
 * the second call is always the same mistake: a sub-plugin that wanted an area
 * of its own and reached for a whole directory.
 */
export function defineAppDataDir(
  app: AppIdentity,
  opts: {
    owner: string;
    description: string;
    movedFrom?: readonly MovedFrom[];
  },
): DataDir {
  if (!NAME_RE.test(app.id))
    throw new Error(
      `[data-dir] app id must match ${String(NAME_RE)} to name its data dir, got ${JSON.stringify(app.id)} (owner ${opts.owner}).`,
    );
  const existing = dataDirs.get(`apps/${app.id}`);
  if (existing)
    throw new Error(
      `[data-dir] app "${app.id}" already owns its data dir (apps/${app.id}, declared by ${existing.spec.owner}). ` +
        `An app owns exactly one data dir — put "${opts.description}" inside it with ` +
        `${appDirConstName(app.id)}.subdir("<area-name>") instead of declaring a second one (attempted from ${opts.owner}).`,
    );
  return register({
    kind: "apps",
    name: app.id,
    owner: opts.owner,
    description: opts.description,
    reclaim: { kind: "never", reason: APP_DIR_RECLAIM_REASON },
    ...(opts.movedFrom ? { movedFrom: opts.movedFrom } : {}),
  });
}

/**
 * A copy of the registry — callers never hold the live map. Keyed
 * `${kind}/${name}`.
 *
 * Its consumer is `paths:no-undeclared-data-dirs`, which diffs it against the
 * real filesystem, and (later) the audit surface and reclaim-driven cleanup.
 * Only complete once every owner's `data-dirs/index.ts` has been loaded — the
 * declarations are side effects of those modules' evaluation.
 */
export function getDataDirs(): ReadonlyMap<string, DataDir> {
  return new Map(dataDirs);
}

/**
 * Where a declared move's bytes land, RELATIVE TO THE DATA ROOT:
 * `state/attachments`, or `apps/desktop/wallpaper` for an area move. The audit
 * compares a `from` symlink's target against this, so it is derived here beside
 * the resolution that performs the move rather than re-spelled by the reader.
 */
export function moveDestination(spec: DataDirSpec, move: MovedFrom): string {
  const key = `${spec.kind}/${spec.name}`;
  return move.to === undefined ? key : `${key}/${move.to}`;
}

/**
 * Is this default export from a `data-dirs/index.ts` really a {@link DataDir}?
 *
 * Lives beside the type it validates, not in one caller: both consumers of the
 * `data-dirs` collected dir — the audit check and the backend publishing its
 * namespace's manifest — must agree on what counts, and a second hand-written
 * copy is how one of them silently starts accepting or rejecting a shape the
 * other does not.
 */
export function isDataDir(value: unknown): value is DataDir {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<DataDir>;
  const spec = candidate.spec as Partial<DataDirSpec> | undefined;
  return (
    typeof spec === "object" &&
    spec !== null &&
    typeof spec.kind === "string" &&
    typeof spec.name === "string" &&
    typeof spec.owner === "string" &&
    typeof candidate.file === "function" &&
    typeof candidate.ensure === "function" &&
    typeof candidate.ensureSync === "function" &&
    typeof candidate.subdir === "function"
  );
}
