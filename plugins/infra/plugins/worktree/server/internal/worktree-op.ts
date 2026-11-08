import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { type FileHandle, open, rm } from "node:fs/promises";
import { readdir, stat } from "@plugins/packages/plugins/timed-fs/core";
import { flockTry } from "@plugins/packages/plugins/flock/server";
import { worktreeDataDir } from "@plugins/infra/plugins/paths/server";
import {
  asNamespace,
  isNamespace,
} from "@plugins/infra/plugins/namespace/core";
import { OP_KIND_IDS, type OpKind } from "@plugins/infra/plugins/worktree/core";
import { liveOpsDir } from "../../data-dirs";

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
// Every v2 marker is also hard-linked into the host-wide `locks/live-ops/` as
// `<slug>~<opId>.json` (the `live-ops` data dir) for as long as it lives. The
// link is the same inode, so its lock is the marker's lock. "What is running
// on this host" reads that one directory — O(live ops) — instead of the ops
// dir of every worktree (~213 of them, all but a handful empty).
//
// Consumers: `./equin await`, the stop guard, and the op-store orphan
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
export function opsDir(slug: string): AppPath {
  return joinAppPath(worktreeDataDir(asNamespace(slug)), "ops");
}

export function opFile(slug: string, opId: string): AppPath {
  return joinAppPath(opsDir(slug), `${opId}.json`);
}

// `~` is in neither a namespace (`[a-z0-9.-]`) nor an op id (a UUID), so the
// first one splits the name back into both.
const LIVE_SEP = "~";

/**
 * The host-wide index entry (a hard link) of op `opId`'s marker. Throws for a
 * pair its name could not be read back into, so a writer fails at its start
 * rather than leave a link every host-wide listing then refuses.
 */
export function liveOpLink(slug: string, opId: string): AppPath {
  const name = `${slug}${LIVE_SEP}${opId}.json`;
  const back = parseLiveOpLink(name);
  if (back?.slug !== slug || back.opId !== opId)
    throw new Error(
      `worktree-op: (${slug}, ${opId}) has no live-op link name — the slug must be a namespace and the op id non-empty without "${LIVE_SEP}"`,
    );
  return joinAppPath(liveOpsDir.path, name);
}

function parseLiveOpLink(name: string): { slug: string; opId: string } | null {
  if (!name.endsWith(".json")) return null;
  const at = name.indexOf(LIVE_SEP);
  if (at <= 0) return null;
  const slug = name.slice(0, at);
  const opId = name.slice(at + 1, -".json".length);
  return isNamespace(slug) && opId && !opId.includes(LIVE_SEP)
    ? { slug, opId }
    : null;
}

// A marker in the making: written, locked, then renamed into place. Readers
// never probe these — a probe landing between the writer's open and its flock
// would steal the lock and fail the writer's start.
export const TMP_SUFFIX = ".tmp";
// A temp file older than this was orphaned by a writer that died between
// create and rename (a microsecond window); only then is it reaped.
const STALE_TMP_MS = 60_000;

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

// Probe one marker file — its `ops/` name or its `live-ops/` link, the same
// inode — reaping it when its op is gone. v2: the try-lock is the answer, and a
// reap unlinks BOTH names, so whichever reader finds the op dead first leaves
// nothing for the other. Legacy (`<kind>.json`, written by a CLI from before
// per-op markers; never linked): its pid. ASYNC so a scan yields the event loop
// (open/read run on the libuv threadpool); the flock itself is a non-blocking
// syscall.
async function probeMarker(slug: string, path: AppPath): Promise<Probe> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "absent" };
    throw err;
  }
  let reap = false;
  // A v2 marker's other name, unlinked with it on a reap.
  let twin: AppPath | null = null;
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
      if (typeof parsed.opId === "string") {
        const link = liveOpLink(slug, parsed.opId);
        twin = path === link ? opFile(slug, parsed.opId) : link;
      }
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
    if (reap) {
      await rm(path, { force: true });
      if (twin) await rm(twin, { force: true });
    }
    await handle.close();
  }
}

async function reapIfStaleTmp(path: AppPath): Promise<void> {
  try {
    const s = await stat(path);
    if (Date.now() - s.mtimeMs > STALE_TMP_MS) await rm(path, { force: true });
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
// here" (the status reconciler), "what is running everywhere" (the stop guard)
// and "is MY op still running" (`./equin await`) — read the directory the
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
      const path = joinAppPath(dir, f);
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

// Every live op on the host: one readdir of the `live-ops` index, one probe per
// entry — O(live ops), never O(worktrees). Reaps as it scans, like
// listWorktreeOps (both names of a dead op).
//
// It sees the ops of every CLI that links its markers — this one on. An op
// started by a checkout's older CLI (a worktree not rebased since) has only its
// per-worktree marker: the per-worktree readers (`listWorktreeOps`,
// `probeWorktreeOp`) still see it, this listing does not.
export async function listActiveWorktreeOps(): Promise<WorktreeOpInfo[]> {
  const dir = liveOpsDir.path;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const probes = await Promise.all(
    names.map(async (name): Promise<Probe> => {
      const key = parseLiveOpLink(name);
      if (!key)
        throw new Error(
          `worktree-op: ${joinAppPath(dir, name)} is not a <slug>~<opId>.json live-op link — nothing else is written there`,
        );
      return probeMarker(key.slug, joinAppPath(dir, name));
    }),
  );
  return probes.flatMap((p) => (p.kind === "live" ? [p.info] : []));
}
