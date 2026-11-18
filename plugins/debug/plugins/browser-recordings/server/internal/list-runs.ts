import {
  readdir,
  readFile,
  stat,
} from "@plugins/packages/plugins/timed-fs/core";
import { join, sep } from "node:path";
import { TOOL_USE_ID_RE } from "@plugins/framework/plugins/tooling/plugins/guards/plugins/tool-use-id/core";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { browserRecordingsDir } from "../../data-dirs";
import {
  browserRecordedCalls,
  browserRecordingRuns,
  MANIFEST_FILE,
  RECORDED_CALLS_FILE,
  RecordedCallsIndexSchema,
  RecordingManifestSchema,
  type BrowserRecordingRun,
} from "../../core";
import { summarizeRun } from "./summarize";

/**
 * The largest manifest this reads. The writer keeps at most
 * `MAX_MANIFEST_STEPS` steps, so a bounded manifest is a few MB at most; one
 * larger was written before that bound (a 105 MB one held 268,535 steps) and
 * is refused loudly rather than parsed on every subscribe.
 */
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

/** One run's manifest, read and summarized for its filmstrip; null while it has none (still running). */
async function readRun(runDir: string): Promise<BrowserRecordingRun | null> {
  const file = join(runDir, MANIFEST_FILE);
  let size: number;
  try {
    ({ size } = await stat(file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (size > MAX_MANIFEST_BYTES)
    throw new Error(
      `${file} is ${(size / 1e6).toFixed(0)} MB, over the ${MAX_MANIFEST_BYTES / 1e6} MB a bounded manifest can reach: it was recorded before the writer bounded its steps`,
    );
  const manifest = RecordingManifestSchema.parse(
    JSON.parse(await readFile(file, "utf8")),
  );
  const { strip, ...run } = summarizeRun(manifest, runDir);
  // Each thumbnail's file version names its resized copy (cached for good).
  // At most MAX_STRIP_FRAMES stats per run.
  const versioned = await Promise.all(
    strip.map(async (f) => {
      const { mtimeMs, size } = await stat(f.frame);
      return { ...f, version: { mtimeMs, size } };
    }),
  );
  return { ...run, strip: versioned };
}

function callDir(toolUseId: string): string {
  if (!TOOL_USE_ID_RE.test(toolUseId))
    throw new Error(`not a tool-use id: ${JSON.stringify(toolUseId)}`);
  return join(browserRecordingsDir.path, toolUseId);
}

/**
 * The runs filed under one tool call. A call that drove no browser has
 * no directory — that is an empty list, the honest answer, not an error. A run
 * still in flight has no manifest yet and is not listed.
 */
async function listRuns({
  toolUseId,
}: {
  toolUseId: string;
}): Promise<{ runs: BrowserRecordingRun[] }> {
  const dir = callDir(toolUseId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { runs: [] };
    throw err;
  }
  const runs: BrowserRecordingRun[] = [];
  for (const name of names) {
    const run = await readRun(join(dir, name));
    if (run !== null) runs.push(run);
  }
  return { runs: runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt)) };
}

/**
 * Pushed when a manifest lands under the call's directory. The watch is on the
 * recordings ROOT, not the call's own directory: a call's directory does not
 * exist until its run starts, and every tuple then shares the root's one
 * native watch (the hub's refcount). A recording writes many frames while it
 * runs; only a manifest moves the answer.
 */
export const browserRecordingRunsServed = serveValue(browserRecordingRuns, {
  source: "external",
  changes: "notified",
  loader: listRuns,
  whileSubscribed: async ({ toolUseId }, notify) => {
    const prefix = callDir(toolUseId) + sep;
    return acquireDirWatch({
      dir: await browserRecordingsDir.ensure(),
      scope: "subtree",
      onChange: (events) => {
        if (
          events.some(
            (e) =>
              e.path.startsWith(prefix) && e.path.endsWith(sep + MANIFEST_FILE),
          )
        )
          notify();
      },
    });
  },
});

/**
 * The calls that still have a run: the writer's index, rewritten after every
 * prune — one file read, never a walk of the call directories (thousands, on
 * the boot path: this value is preloaded). A store the writer has not indexed
 * yet answers `unindexed`, and the view falls back to asking per call.
 */
async function listRecordedCalls(): Promise<
  { kind: "indexed"; toolUseIds: string[] } | { kind: "unindexed" }
> {
  let text: string;
  try {
    text = await readFile(
      join(browserRecordingsDir.path, RECORDED_CALLS_FILE),
      "utf8",
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "unindexed" };
    throw err;
  }
  return {
    kind: "indexed",
    toolUseIds: RecordedCallsIndexSchema.parse(JSON.parse(text)),
  };
}

/** Pushed when the writer rewrites the index. */
export const browserRecordedCallsServed = serveValue(browserRecordedCalls, {
  source: "external",
  changes: "notified",
  loader: listRecordedCalls,
  whileSubscribed: async (_params, notify) =>
    acquireDirWatch({
      dir: await browserRecordingsDir.ensure(),
      scope: "subtree",
      onChange: (events) => {
        if (events.some((e) => e.path.endsWith(sep + RECORDED_CALLS_FILE)))
          notify();
      },
    }),
});
