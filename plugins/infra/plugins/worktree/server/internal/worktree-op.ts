import {
  closeSync,
  type Dirent,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { type FileHandle, open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { flockTry } from "@plugins/packages/plugins/flock/server";
import {
  worktreesDir,
  worktreeDataDir,
} from "@plugins/infra/plugins/paths/server";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import { OP_KIND_IDS, type OpKind } from "@plugins/infra/plugins/worktree/core";

// A per-op, crash-safe liveness marker for a long-running operation (build,
// push, check, test, e2e — the `OpKind` vocabulary declared once in this
// plugin's core). It answers exactly one question: "is this op's process still
// running?" What the op is DOING (queued, parked on a wait, working) is the op
// log's business — the marker carries no phase.
//
// The file is `worktrees/<slug>/ops/<opId>.json` = {v:2, kind, opId, pid,
// startedAt}, and its writer holds a kernel `flock` on it for the op's whole
// life. The lock IS the liveness: the kernel drops it when the process dies —
// SIGKILL, OOM and power loss included — and no pid is ever consulted, so pid
// reuse cannot make a dead op look alive. A reader probes with a non-blocking
// try-lock: failing to take it ⇒ the op is running; taking it ⇒ the writer is
// gone, and the reader reaps the file.
//
// One file per op (not per (worktree, kind)): two checks in one worktree are two
// markers, so neither overwrites the other and every reader sees both.
//
// Consumers: `./singularity await`, the stop guard, and the op-store orphan
// reconciler. Markers are keyed
// on the checkout's namespace, which every writer (`build` / `push` / direct
// ops) and reader agrees on.
export type WorktreeOp = OpKind;

const KNOWN_OPS: readonly WorktreeOp[] = OP_KIND_IDS;

export interface WorktreeOpInfo {
  slug: string;
  op: WorktreeOp;
  // The CLI process running the op — the stable handle a consumer needs to
  // `sample`/`ps` a suspect op, and `await`'s fallback death check.
  pid: number;
  // The op-log id of the run this marker stands for. Always set on a v2
  // marker; null only for a legacy per-kind marker an older CLI wrote without
  // one. The marker answers "is it running", the op log "what did it end as" —
  // and this is the join.
  opId: string | null;
  startedAt: string;
}

// Op markers are keyed by the same slug the spec dir carries, and a slug reaches
// here from a marker file or a directory listing — so this, the one place a slug
// becomes a path, is where it is validated back into a namespace.
function opsDir(slug: string): string {
  return join(worktreeDataDir(asNamespace(slug)), "ops");
}

function opFile(slug: string, opId: string): string {
  return join(opsDir(slug), `${opId}.json`);
}

// A marker in the making: written, locked, then renamed into place. Readers
// never probe these — a probe landing between the writer's open and its flock
// would steal the lock and fail the writer's start.
const TMP_SUFFIX = ".tmp";
// A temp file older than this was orphaned by a writer that died between
// create and rename (a microsecond window); only then is it reaped.
const STALE_TMP_MS = 60_000;

/** The held marker of one running op. */
export interface WorktreeOpMarker {
  readonly path: string;
  /**
   * Unlink the marker and drop its lock. Call it AFTER the op's terminal event
   * is in the op log: a reader that sees the marker gone must find the verdict
   * already written, never an op that looks killed. Idempotent.
   */
  release(): void;
}

/**
 * Publish this process's liveness marker for op `opId` and hold its lock until
 * `release()` (or process death — the kernel releases it either way).
 *
 * Written to a temp file, locked, then renamed into place, so a reader only
 * ever sees a complete file that is already locked. The fd is opened
 * close-on-exec (Bun/libuv open every fd `O_CLOEXEC`), so a child the op spawns
 * does not inherit it: the lock ends with THIS process, however long a child
 * lingers. (The marker test pins that.)
 *
 * `opId` is required: every writer mints one for the op log before it writes
 * its marker, and a marker without it is a live op nobody can look up the
 * outcome of.
 */
export function markWorktreeOpStart(
  slug: string,
  op: WorktreeOp,
  opId: string,
): WorktreeOpMarker {
  const dir = opsDir(slug);
  mkdirSync(dir, { recursive: true });
  const path = opFile(slug, opId);
  const tmp = `${path}.${process.pid}${TMP_SUFFIX}`;
  const fd = openSync(tmp, "w");
  try {
    if (!flockTry(fd))
      throw new Error(
        `worktree-op: could not lock a marker file this process just created (${tmp})`,
      );
    writeSync(
      fd,
      JSON.stringify({
        v: 2,
        kind: op,
        opId,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }),
    );
    renameSync(tmp, path);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  let released = false;
  return {
    path,
    release: () => {
      if (released) return;
      released = true;
      // Unlink first, then close: a reader that opened the file before the
      // unlink and takes the lock after the close only reaps an already-gone
      // path.
      rmSync(path, { force: true });
      closeSync(fd);
    },
  };
}

// Signal 0 probes existence without delivering anything. EPERM: alive, but
// another user's. Only for LEGACY markers — a v2 marker's liveness is its lock.
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

type MarkerJson = {
  v?: unknown;
  kind?: unknown;
  op?: unknown;
  pid?: unknown;
  opId?: unknown;
  startedAt?: unknown;
};

function opOf(raw: unknown): WorktreeOp {
  return KNOWN_OPS.includes(raw as WorktreeOp) ? (raw as WorktreeOp) : "build";
}

function infoFromParsed(
  slug: string,
  parsed: MarkerJson,
): WorktreeOpInfo | null {
  if (typeof parsed.pid !== "number") return null;
  return {
    slug,
    // v2 names it `kind`; a legacy marker `op`.
    op: opOf(parsed.v === 2 ? parsed.kind : parsed.op),
    pid: parsed.pid,
    opId: typeof parsed.opId === "string" ? parsed.opId : null,
    startedAt:
      typeof parsed.startedAt === "string"
        ? parsed.startedAt
        : new Date(0).toISOString(),
  };
}

/** What a probe of one marker file found. */
type Probe =
  | { kind: "live"; info: WorktreeOpInfo }
  | { kind: "dead" }
  | { kind: "absent" };

// Probe one marker file, reaping it when its op is gone. v2: the try-lock is
// the answer. Legacy (`<kind>.json`, written by a CLI from before per-op
// markers): its pid. ASYNC so a scan yields the event loop (open/read run on the
// libuv threadpool); the flock itself is a non-blocking syscall.
async function probeMarker(slug: string, path: string): Promise<Probe> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "absent" };
    throw err;
  }
  let reap = false;
  try {
    const text = await handle.readFile("utf8");
    let parsed: MarkerJson;
    try {
      parsed = JSON.parse(text) as MarkerJson;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      // A v2 marker is renamed in whole, so garbage is a legacy torn write or
      // junk: reclaim it — unless someone holds its lock.
      reap = flockTry(handle.fd);
      return reap ? { kind: "dead" } : { kind: "absent" };
    }
    if (parsed.v === 2) {
      // Taking the lock ⇒ its holder is gone. Keep it until the unlink below,
      // so nothing else can judge the file mid-reap.
      if (flockTry(handle.fd)) {
        reap = true;
        return { kind: "dead" };
      }
      const info = infoFromParsed(slug, parsed);
      return info ? { kind: "live", info } : { kind: "dead" };
    }
    const info = infoFromParsed(slug, parsed);
    if (info && isPidAlive(info.pid)) return { kind: "live", info };
    reap = true;
    return { kind: "dead" };
  } finally {
    if (reap) rmSync(path, { force: true });
    await handle.close();
  }
}

async function reapIfStaleTmp(path: string): Promise<void> {
  try {
    const s = await stat(path);
    if (Date.now() - s.mtimeMs > STALE_TMP_MS) rmSync(path, { force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Is op `opId` running? `live` (its v2 marker is locked), `dead` (the marker
 * was there and unlocked — reaped now), or `absent` (no v2 marker for it: never
 * written, already released, or already reaped). For a caller that must tell
 * "the op died" from "this op never had a per-op marker" — the reconciler,
 * while ops from older CLIs are still in the log.
 */
export async function probeWorktreeOp(
  slug: string,
  opId: string,
): Promise<"live" | "dead" | "absent"> {
  return (await probeMarker(slug, opFile(slug, opId))).kind;
}

// Every live op marker for ONE worktree. Reaps dead or unparseable markers as it
// scans; per-file probes run in parallel.
//
// The one scan, so the questions asked of these markers — "is anything running
// here" (the tmux status poller), "what is running everywhere" (the stop guard)
// and "is MY op still running" (`./singularity await`) — read the directory the
// same way and reap on the same rule.
export async function listWorktreeOps(slug: string): Promise<WorktreeOpInfo[]> {
  const dir = opsDir(slug);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const probes = await Promise.all(
    files.map(async (f): Promise<Probe> => {
      const path = join(dir, f);
      if (f.endsWith(TMP_SUFFIX)) {
        await reapIfStaleTmp(path);
        return { kind: "absent" };
      }
      return probeMarker(slug, path);
    }),
  );
  return probes.flatMap((p) => (p.kind === "live" ? [p.info] : []));
}

// True iff any op marker for this worktree is live.
export async function isWorktreeOpActive(slug: string): Promise<boolean> {
  return (await listWorktreeOps(slug)).length > 0;
}

// Every live op marker across all worktrees. Reaps as it scans, like
// listWorktreeOps; per-slug scans run in parallel.
export async function listActiveWorktreeOps(): Promise<WorktreeOpInfo[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(worktreesDir(), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const perSlug = await Promise.all(
    entries.map(async (entry): Promise<WorktreeOpInfo[]> => {
      // worktreesDir() holds both worktree directories AND per-worktree gateway
      // registration files (`<slug>.json`); only directories carry an ops/
      // subdir, so descending into a `.json` file would throw ENOTDIR.
      if (!entry.isDirectory()) return [];
      return listWorktreeOps(entry.name);
    }),
  );
  return perSlug.flat();
}
