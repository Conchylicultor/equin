import { createHash } from "node:crypto";
import { mkdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { readdir, stat } from "@plugins/packages/plugins/timed-fs/core";
import { basename, dirname, join } from "node:path";
import { TOOL_USE_ID_RE } from "@plugins/framework/plugins/tooling/plugins/guards/core";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { flockTry, waitForFlock } from "@plugins/packages/plugins/flock/core";
import { openOwnedFd } from "@plugins/packages/plugins/owned-fd/core";
import {
  MANIFEST_FILE,
  RECORDED_CALLS_FILE,
  type RecordingManifest,
  type RecordingSource,
  type RecordingStep,
} from "@plugins/debug/plugins/browser-recordings/core";

/** How many runs the recordings directory keeps, newest first, across all calls. */
const KEEP_RUNS = 200;

/**
 * The prune's host-wide lock, at the root. Every recording on the machine — each
 * `browser_*` MCP call of every agent, each e2e run — prunes the same root when
 * it closes, so prunes overlap routinely. Unserialized, one prune removed a call
 * directory it had just emptied between another's root listing and its
 * `readdir` of that directory, and the other threw ENOENT from inside an e2e
 * run's teardown.
 */
const PRUNE_LOCK_FILE = ".prune.lock";

export type FrameFormat = "png" | "jpeg";

export interface Recording {
  /** The run's directory, absolute. */
  readonly dir: string;
  /** Milliseconds since the recording opened — a step's `startMs` clock. */
  elapsedMs(): number;
  /**
   * Store one frame (a PNG or a JPEG) and return its path. The same picture
   * (by content) is stored once, so a run of steps that ended on one screen
   * costs one file.
   */
  frame(image: Uint8Array, format: FrameFormat): Promise<string>;
  /** Write the manifest — the recording becomes visible — and prune old runs. */
  close(steps: readonly RecordingStep[]): Promise<RecordingManifest>;
}

/**
 * Open one recording under `<root>/<toolUseId | "manual">/<runId>/`. A
 * recording without a manifest is invisible: `close()` writes it last, so a
 * run killed midway leaves frames nobody lists (and the pruning removes them).
 */
export function openRecording(opts: {
  root: AppPath;
  toolUseId: string | null;
  source: RecordingSource;
  /** A short, filename-safe name for the run directory, e.g. the script's basename. */
  name: string;
}): Recording {
  const { root, toolUseId, source } = opts;
  if (toolUseId !== null && !TOOL_USE_ID_RE.test(toolUseId))
    throw new Error(`not a tool-use id: ${JSON.stringify(toolUseId)}`);
  const startedAt = new Date();
  const t0 = performance.now();
  const runId = `${startedAt.toISOString().replace(/[:.]/g, "-")}-${opts.name.replace(/[^A-Za-z0-9_-]/g, "_")}-${process.pid}`;
  const dir = join(root, toolUseId ?? "manual", runId);
  const framesDir = join(dir, "frames");
  const stored = new Map<string, Promise<string>>();

  return {
    dir,
    elapsedMs: () => Math.round(performance.now() - t0),
    frame(image, format) {
      const sha1 = createHash("sha1").update(image).digest("hex");
      let path = stored.get(sha1);
      if (path === undefined) {
        const file = join(
          framesDir,
          `${sha1}.${format === "png" ? "png" : "jpg"}`,
        );
        path = mkdir(framesDir, { recursive: true })
          .then(() => writeFile(file, image))
          .then(() => file);
        stored.set(sha1, path);
      }
      return path;
    },
    async close(steps) {
      await Promise.all(stored.values());
      const manifest: RecordingManifest = {
        v: 2,
        source,
        toolUseId,
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        steps: [...steps],
      };
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, MANIFEST_FILE),
        JSON.stringify(manifest, null, 2),
      );
      await pruneRuns(root, KEEP_RUNS);
      return manifest;
    },
  };
}

/**
 * Delete all but the newest `keep` run directories (`<root>/<call>/<run>`) —
 * one prune at a time on the host. When another process holds the lock this
 * one waits its turn (push-based: `waitForFlock`'s child is woken by the
 * kernel) rather than skipping: the holder listed the root before this run's
 * manifest may have existed, so only a prune after it is sure to put this run
 * in the recorded-calls index.
 */
async function pruneRuns(root: AppPath, keep: number): Promise<void> {
  const path = joinAppPath(root, PRUNE_LOCK_FILE);
  // "a": create without truncating — the lock file's content is never read.
  const lock = await openOwnedFd(path, "a");
  if (flockTry(lock.fd)) {
    try {
      await pruneRunsLocked(root, keep);
    } finally {
      // Closing the descriptor releases its lock.
      lock.close();
    }
    return;
  }
  lock.close();
  const held = await waitForFlock(path);
  try {
    await pruneRunsLocked(root, keep);
  } finally {
    await held.release();
  }
}

async function pruneRunsLocked(root: AppPath, keep: number): Promise<void> {
  const runs: { path: string; mtimeMs: number }[] = [];
  for (const call of await readdir(root, { withFileTypes: true })) {
    if (!call.isDirectory()) continue;
    const callDir = join(root, call.name);
    for (const run of await readdir(callDir, { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      const path = join(callDir, run.name);
      runs.push({ path, mtimeMs: (await stat(path)).mtimeMs });
    }
  }
  runs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const run of runs.slice(keep)) {
    await rm(run.path, { recursive: true, force: true });
    // A call whose last run went goes too, so the directory lists only the
    // calls that still have a recording (`browser-recordings.recorded-calls`).
    // `rmdir`, never a recursive rm after a listing: a recording opening a
    // run in this call (a writer takes no lock) may land between the two, and
    // a recursive rm would delete that live run under it.
    const callDir = dirname(run.path);
    await rmdir(callDir).catch((err: unknown) => {
      if (!(err instanceof Error && "code" in err && err.code === "ENOTEMPTY"))
        throw err;
    });
  }
  // The calls that still have a run, for the view's preloaded set
  // (`browser-recordings.recorded-calls`). Written whole and renamed into
  // place, so a reader never sees half a file.
  const calls = new Set(
    runs
      .slice(0, keep)
      .map((run) => basename(dirname(run.path)))
      .filter((call) => TOOL_USE_ID_RE.test(call)),
  );
  const index = join(root, RECORDED_CALLS_FILE);
  await writeFile(`${index}.tmp`, JSON.stringify([...calls].sort()));
  await rename(`${index}.tmp`, index);
}
