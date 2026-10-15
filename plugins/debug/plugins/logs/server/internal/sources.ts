import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  getFileSinks,
  sanitizeChannel,
  type FileSink,
} from "@plugins/infra/plugins/file-sink/core";
import {
  clientLogFamily,
  logsDir,
  logsDirFor,
} from "@plugins/primitives/plugins/log-channels/server";
import { gatewayLogs } from "@plugins/infra/plugins/launcher/data-dirs";
import { isNamespace } from "@plugins/infra/plugins/namespace/core";
import type { LogScope } from "../../shared/resources";

/** A log the viewer can open: where its live file is and who declared it. */
export interface LogSource {
  id: string;
  scope: LogScope;
  description: string | null;
  path: string;
  bound: { maxBytes: number; keep: number } | null;
}

/** The id the backend process's own output is opened by. */
export const BACKEND_LOG_ID = "backend";

const boundOf = (sink: FileSink): LogSource["bound"] => ({
  maxBytes: sink.bound.maxBytes,
  keep: sink.bound.keep,
});

/**
 * Every log of `worktree`, in precedence order (an id two sources share opens
 * the first): the `defineLogSink` channels this process declares (each a file
 * in that worktree's logs folder, whether or not it was written there yet), the
 * backend's own output the gateway captures, the host-wide sinks, and the
 * files in the logs folder nothing declares.
 *
 * The declarations are this process's: every backend runs the same plugins, so
 * they describe the other worktrees' folders too, up to code that differs
 * between their checkouts.
 */
export async function logSources(worktree: string): Promise<LogSource[]> {
  if (!isNamespace(worktree)) throw new InvalidWorktree(worktree);
  const dir = logsDirFor(worktree);
  const ownDir = logsDir();
  const sources: LogSource[] = [];
  const declared = new Set<string>();

  const host: LogSource[] = [];
  for (const sink of getFileSinks().values()) {
    if (sink === clientLogFamily) continue; // stands for the undeclared files below
    if (dirname(sink.path) === ownDir) {
      const file = sanitizeChannel(sink.id) + ".jsonl";
      declared.add(file);
      sources.push({
        id: sink.id,
        scope: "worktree",
        description: sink.description,
        path: join(dir, file),
        bound: boundOf(sink),
      });
    } else {
      host.push({
        id: sink.id,
        scope: "host",
        description: sink.description,
        path: sink.path,
        bound: boundOf(sink),
      });
    }
  }

  sources.push({
    id: BACKEND_LOG_ID,
    scope: "backend",
    description:
      "This worktree's backend process: everything it printed on stdout and stderr, captured by the gateway that launched it.",
    path: gatewayLogs.file(`${worktree}.log`),
    // The gateway rotates this file itself; no sink here declares its bound.
    bound: null,
  });
  sources.push(...host);

  for (const file of await listJsonl(dir)) {
    if (declared.has(file)) continue;
    sources.push({
      id: file.slice(0, -".jsonl".length),
      scope: "undeclared",
      description: null,
      path: join(dir, file),
      // The clientLog family's bound — true for a clientLog channel, the one
      // writer that may put an undeclared file here.
      bound: boundOf(clientLogFamily),
    });
  }
  return sources;
}

/** The source `id` opens in `worktree`, or `null` when there is none. */
export async function findLogSource(
  worktree: string,
  id: string,
): Promise<LogSource | null> {
  return (await logSources(worktree)).find((s) => s.id === id) ?? null;
}

export class InvalidWorktree extends Error {
  constructor(worktree: string) {
    super(`not a worktree name: ${JSON.stringify(worktree)}`);
  }
}

async function listJsonl(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => n.endsWith(".jsonl"));
  } catch (err) {
    // A worktree that never logged has no folder yet: it has no files.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
