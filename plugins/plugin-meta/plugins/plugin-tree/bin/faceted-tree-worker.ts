import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { z } from "zod";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { dropIgnoredPaths } from "@plugins/framework/plugins/tooling/core";
import { installRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/core";
import { openRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/cli";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  journalChangesSince,
  journalCursor,
  type JournalCursorResult,
} from "@plugins/infra/plugins/file-watcher/server";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import {
  openFacetedIndex,
  type FacetedIndex,
  type FacetedResume,
} from "@plugins/plugin-meta/plugins/plugin-tree/plugins/faceted/core";
import type { FromWorkerFrame, ToWorkerFrame } from "../shared/protocol";

// The faceted-tree worker: one thread holding this checkout's faceted index
// (`faceted`'s `openFacetedIndex`), started by the backend (`machine/`) through the
// daemon primitive. The facet extractors are build tooling, so they run here —
// on another thread, by path, never in the backend's own import closure
// (`boot:closure-digestable`).
//
// Frames are handled one at a time, in arrival order: the index is not
// re-entrant, and a refresh must see the one before it applied.
//
// Across processes. The backend restarts on every deploy, and with it this
// thread; a cold build lists the whole checkout with git although almost
// nothing changed since the last one. So each build leaves a checkpoint
// (`init.checkpointFile`): the index's file set (`FacetedCheckpoint`) and a
// file-system journal cursor taken BEFORE the build — and the next worker
// starts from it, asking git only about the paths the journal names under the
// checkout since that cursor (`infra/file-watcher`'s journal: O(changes),
// fail-closed). Any path named again is re-asked, so a cursor older than the
// state it is saved with costs a re-check, never a miss. Whatever the journal
// cannot vouch for, or a checkpoint this code cannot read, starts cold, the
// answer that is always right. The backend's watcher is armed before this
// thread is started, so a change after the replay is a refresh frame.

declare const self: Worker;

const post = (frame: FromWorkerFrame): void => self.postMessage(frame);

let root: string | null = null;
let index: FacetedIndex | null = null;
let queue: Promise<void> = Promise.resolve();

/**
 * The repo files this thread has loaded — its own code. A refresh naming one
 * means the index was built by code no longer on disk (`code-changed`).
 */
function* codeFiles(): Iterable<string> {
  if (root === null) return;
  for (const path of [import.meta.path, ...Object.keys(require.cache)]) {
    if (!path.startsWith(`${root}/`) || path.includes("/node_modules/"))
      continue;
    yield relative(root, path);
  }
}

/** A checkpoint file as this worker writes it (see the module comment). */
const checkpointFileSchema = z.object({
  cursor: z.object({
    root: z.string(),
    dev: z.number(),
    ino: z.number(),
    eventId: z.string(),
    takenAt: z.number(),
    snapshot: z.string(),
  }),
  checkpoint: z.object({
    membership: z.string(),
    members: wholeList(z.tuple([z.string(), z.string()]), {
      reason:
        "the checkout's whole file set, read once per worker start to skip listing it",
    }),
    listedAt: z.number(),
  }),
});
type CheckpointFile = z.infer<typeof checkpointFileSchema>;

/**
 * More paths than this, and one whole listing is cheaper than asking git
 * about each (a checkout, a rebase) — the backend's watcher drops its index
 * past the same size (`MAX_SCOPED_PATHS`).
 */
const MAX_RESUMED_PATHS = 2_000;

/**
 * How long a set may be carried from checkpoint to checkpoint before git
 * lists it whole again. The journal is blind to a few changes a listing sees
 * — git's index alone (`git rm --cached`, `add -f`), a linked worktree's
 * exclude file (in the shared git dir, outside the checkout), a binary file
 * re-hashed as text — so what they leave wrong lasts until then at most. A
 * day: one cold listing among main's ~50 restarts.
 */
const MAX_LISTING_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Where the index starts from: the checkpoint and the repo-relative paths the
 * journal names under `root` since its cursor — or cold, and why.
 */
async function resumeFrom(root: string, file: string): Promise<FacetedResume> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { kind: "cold", reason: "no checkpoint yet" };
  }
  // Written by an earlier worker, maybe of other code (or cut short by a
  // crash before it reached the disk): one this code cannot read is a reason
  // to start cold, not a fault — the build overwrites it.
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { kind: "cold", reason: "the checkpoint is not JSON" };
  }
  const parsed = checkpointFileSchema.safeParse(json);
  if (!parsed.success)
    return { kind: "cold", reason: "the checkpoint is in another format" };
  const saved = parsed.data;
  if (saved.cursor.root !== root)
    return { kind: "cold", reason: `the checkpoint is ${saved.cursor.root}'s` };
  if (Date.now() - saved.checkpoint.listedAt > MAX_LISTING_AGE_MS)
    return { kind: "cold", reason: "its last whole listing is a day old" };
  const replay = await journalChangesSince(saved.cursor);
  if (replay.kind === "unknown")
    return { kind: "cold", reason: `the journal: ${replay.reason}` };
  const named = new Set<string>();
  for (const path of replay.paths) {
    if (!path.startsWith(`${root}/`))
      return { kind: "cold", reason: `the journal names ${path}` };
    const rel = path.slice(root.length + 1);
    const segments = rel.split("/");
    // git's own files: only its exclude file moves membership. (A linked
    // worktree's git dir is outside the checkout, as for the watcher.)
    if (segments[0] === ".git") {
      if (rel === ".git/info/exclude")
        return { kind: "cold", reason: "git's exclude file changed" };
      continue;
    }
    // Never members, and thousands of them after an install — the
    // backend's watcher ignores them too.
    if (segments.includes("node_modules")) continue;
    named.add(rel);
  }
  // A build's output, the agents' checkouts under main's ignored
  // `.claude/worktrees/`: never members, so no change to ask about.
  const changed = await dropIgnoredPaths(root as AppPath, [...named]);
  if (changed.length > MAX_RESUMED_PATHS)
    return {
      kind: "cold",
      reason: `${changed.length} paths changed since the checkpoint`,
    };
  return { kind: "checkpoint", checkpoint: saved.checkpoint, changed };
}

/** Temp file + rename: a worker starting meanwhile never reads half of one. */
async function writeCheckpoint(
  file: string,
  value: CheckpointFile,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
}

async function handle(frame: ToWorkerFrame): Promise<void> {
  const t0 = performance.now();
  if (frame.type === "init") {
    let built: FacetedIndex;
    let cursor: Promise<JournalCursorResult>;
    try {
      root = frame.root;
      installRecordStore(openRecordStore());
      // Taken before anything is read: a change from here on is named by
      // the next worker's replay, whatever this build saw of it.
      cursor = journalCursor(frame.root);
      built = await openFacetedIndex(frame.root as AppPath, {
        readConcurrency: 8,
        codeFiles,
        resume: cursor.then(() => resumeFrom(frame.root, frame.checkpointFile)),
      });
      index = built;
      post({
        type: "ready",
        delta: built.full(),
        ms: performance.now() - t0,
        start: built.start,
      });
    } catch (err) {
      post({ type: "failed", id: null, message: describe(err) });
      return;
    }
    // The index is good whatever happens to its checkpoint: a failure to
    // leave one is reported, never the end of the session; the next worker
    // starts from the older one (its cursor older still: a re-check, never a
    // miss), or cold.
    try {
      const taken = await cursor;
      // No journal here (not FSEvents, another volume): every start is cold.
      if (taken.kind === "cursor")
        await writeCheckpoint(frame.checkpointFile, {
          cursor: taken.cursor,
          checkpoint: await built.checkpoint(),
        });
    } catch (err) {
      post({ type: "checkpoint-failed", message: describe(err) });
    }
    return;
  }
  if (index === null) {
    post({
      type: "failed",
      id: frame.id,
      message: "refresh before the index was built",
    });
    return;
  }
  try {
    const result = await index.refresh(frame.paths, frame.edited);
    post({
      type: "refreshed",
      id: frame.id,
      ms: performance.now() - t0,
      result,
    });
  } catch (err) {
    // A half-applied refresh leaves the index inconsistent: never use it again.
    index = null;
    post({ type: "failed", id: frame.id, message: describe(err) });
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

self.onmessage = (event: MessageEvent<ToWorkerFrame>) => {
  const frame = event.data;
  queue = queue.then(() => handle(frame));
};
