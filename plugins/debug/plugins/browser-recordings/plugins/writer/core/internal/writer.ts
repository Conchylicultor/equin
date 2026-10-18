import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TOOL_USE_ID_RE } from "@plugins/framework/plugins/tooling/plugins/guards/core";
import {
  MANIFEST_FILE,
  type RecordingManifest,
  type RecordingSource,
  type RecordingStep,
} from "@plugins/debug/plugins/browser-recordings/core";

/** How many runs the recordings directory keeps, newest first, across all calls. */
const KEEP_RUNS = 200;

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
  root: string;
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

/** Delete all but the newest `keep` run directories (`<root>/<call>/<run>`). */
async function pruneRuns(root: string, keep: number): Promise<void> {
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
  for (const run of runs.slice(keep))
    await rm(run.path, { recursive: true, force: true });
}
