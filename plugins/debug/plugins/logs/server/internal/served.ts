import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { serveValue } from "@plugins/network/plugins/live/server";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import {
  historyCutAt,
  isHistoryPosition,
  readHistory,
  statHistory,
} from "@plugins/infra/plugins/file-sink/core";
import { logLines, logsCatalog, type LogEntry } from "../../shared/resources";
import {
  findLogSource,
  InvalidWorktree,
  logSources,
  type LogSource,
} from "./sources";
import { parseLine, timeOfLine } from "./parse-line";

/**
 * Watch the folders holding `sources` until the returned stop runs, calling
 * `notify` when a file of one of them (its live file or a rotation) changes.
 * A folder that does not exist yet is created: each is the declared home of
 * its logs, and a worktree that never logged still has a valid, empty answer
 * to watch.
 */
async function watchSources(
  sources: readonly LogSource[],
  notify: () => void,
): Promise<() => void> {
  const byDir = new Map<string, Set<string>>();
  for (const s of sources) {
    const dir = dirname(s.path);
    const names = byDir.get(dir) ?? new Set<string>();
    names.add(basename(s.path));
    byDir.set(dir, names);
  }
  const releases: (() => void)[] = [];
  try {
    for (const [dir, names] of byDir) {
      await mkdir(dir, { recursive: true });
      releases.push(
        await acquireDirWatch({
          dir,
          scope: "children",
          onChange: (events) => {
            // A rotation is `<file>.N`: match the live name and its suffixes.
            const hit = events.some((e) => {
              const name = basename(e.path);
              for (const n of names)
                if (name === n || name.startsWith(n + ".")) return true;
              return false;
            });
            if (hit) notify();
          },
        }),
      );
    }
  } catch (err) {
    for (const release of releases) release();
    throw err;
  }
  // A write between the first load and the watches opening produced no event.
  notify();
  return () => {
    for (const release of releases) release();
  };
}

/**
 * Every log of one worktree with its files' sizes and ages. The logs folder of
 * a busy worktree changes every few seconds, so a recompute is throttled; it
 * only stats files.
 */
export const logsCatalogServed = serveValue(logsCatalog, {
  source: "external",
  changes: "notified",
  // Under the 1 s update budget: a change waits at most this long to be sent.
  throttleMs: 500,
  loader: async ({ worktree }): Promise<{ entries: LogEntry[] }> => {
    const sources = await sourcesOrRefuse(worktree);
    const entries = await Promise.all(
      sources.map(async (s): Promise<LogEntry> => {
        const files = await statHistory(s.path);
        return {
          ...s,
          files: files.map((f) => ({
            generation: f.generation,
            bytes: f.bytes,
            bornMs: f.bornMs,
            modifiedMs: f.modifiedMs,
          })),
        };
      }),
    );
    return { entries };
  },
  whileSubscribed: async ({ worktree }, notify) => {
    // An invalid worktree watches nothing: the loader refuses it.
    if (!(await validWorktree(worktree))) return () => {};
    // Undeclared files appear and vanish: watch the folders, not a fixed file
    // set, so a new one is heard.
    const sources = await logSources(worktree);
    return watchFolders(sources, notify);
  },
});

/** Like `watchSources`, but hearing every file of each folder. */
async function watchFolders(
  sources: readonly LogSource[],
  notify: () => void,
): Promise<() => void> {
  const backend = sources.find((s) => s.scope === "backend");
  const ownFolders = sources.filter(
    (s) =>
      s.scope === "worktree" || s.scope === "undeclared" || s.scope === "host",
  );
  // The gateway's folder holds every worktree's capture: hear only this one.
  const releaseBackend = backend ? await watchSources([backend], notify) : null;
  const dirs = [...new Set(ownFolders.map((s) => dirname(s.path)))];
  const releases: (() => void)[] = [];
  try {
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
      releases.push(
        await acquireDirWatch({
          dir,
          scope: "children",
          onChange: () => notify(),
        }),
      );
    }
  } catch (err) {
    for (const release of releases) release();
    releaseBackend?.();
    throw err;
  }
  return () => {
    for (const release of releases) release();
    releaseBackend?.();
  };
}

/**
 * One log's lines, newest first, a key range at a time: from the cut the page
 * starts after (or the newest line — or the newest at `at`) back toward the
 * page's lower cut, across every kept file. The log's folder is watched for as
 * long as a page is read, so a new line reaches page 0 and a rotation
 * re-reads the pages whose lines moved file.
 */
export const logLinesServed = serveValue(logLines, {
  source: "external",
  changes: "notified",
  throttleMs: 500,
  loader: async (q, range) => {
    const source = await sourceOrRefuse(q.worktree, q.log);
    const after = range.after?.id ?? null;
    const until = range.until?.id ?? null;
    for (const cut of [after, until]) {
      if (cut !== null && !isHistoryPosition(cut))
        throw logLines.refuse("invalid-cut", `not a log position: ${cut}`);
    }
    let before = after;
    if (before === null && q.at !== null) {
      before = await historyCutAt(source.path, q.at, timeOfLine);
      // Every kept line is newer than `at`: nothing at or before it.
      if (before === null) return [];
    }
    const lines = await readHistory(source.path, {
      before,
      notBefore: until,
      limit: range.limit,
    });
    return lines.map((l) => ({
      position: l.position,
      generation: l.generation,
      ...parseLine(l.text),
    }));
  },
  whileSubscribed: async (q, notify) => {
    const source = await findSourceQuietly(q.worktree, q.log);
    // An unknown log watches nothing: the loader refuses it.
    if (source === null) return () => {};
    return watchSources([source], notify);
  },
});

async function validWorktree(worktree: string): Promise<boolean> {
  try {
    await logSources(worktree);
    return true;
  } catch (err) {
    if (err instanceof InvalidWorktree) return false;
    throw err;
  }
}

async function sourcesOrRefuse(worktree: string): Promise<LogSource[]> {
  try {
    return await logSources(worktree);
  } catch (err) {
    if (err instanceof InvalidWorktree)
      throw logsCatalog.refuse("invalid-worktree", err.message);
    throw err;
  }
}

async function sourceOrRefuse(
  worktree: string,
  id: string,
): Promise<LogSource> {
  let source: LogSource | null;
  try {
    source = await findLogSource(worktree, id);
  } catch (err) {
    if (err instanceof InvalidWorktree)
      throw logLines.refuse("invalid-worktree", err.message);
    throw err;
  }
  if (source === null)
    throw logLines.refuse(
      "unknown-log",
      `no log ${JSON.stringify(id)} in ${worktree}`,
    );
  return source;
}

async function findSourceQuietly(
  worktree: string,
  id: string,
): Promise<LogSource | null> {
  try {
    return await findLogSource(worktree, id);
  } catch (err) {
    if (err instanceof InvalidWorktree) return null;
    throw err;
  }
}
