import { readdir, readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { TOOL_USE_ID_RE } from "@plugins/framework/plugins/tooling/plugins/guards/core";
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
    const runDir = join(dir, name);
    let text: string;
    try {
      text = await readFile(join(runDir, MANIFEST_FILE), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    runs.push({
      ...RecordingManifestSchema.parse(JSON.parse(text)),
      dir: runDir,
    });
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
      dir: browserRecordingsDir.ensure(),
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
      dir: browserRecordingsDir.ensure(),
      scope: "subtree",
      onChange: (events) => {
        if (events.some((e) => e.path.endsWith(sep + RECORDED_CALLS_FILE)))
          notify();
      },
    }),
});
