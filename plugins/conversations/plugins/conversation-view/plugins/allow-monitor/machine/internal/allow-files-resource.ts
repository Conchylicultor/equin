import { basename, join } from "path";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import { createParkedWatches } from "@plugins/packages/plugins/parked-watch/core";
import { BYPASS_TOKENS } from "@plugins/framework/plugins/tooling/plugins/guards/core";
import { workspaceOfConversationLookup } from "@plugins/tasks/plugins/tasks-core/server";
import { allowFiles, type AllowFiles } from "../../core";

// The directory the conversation's agent runs in (its attempt's worktree, or a
// scratch workspace's directory) — null for an unknown conversation or one with
// no path yet. Through tasks-core's compiled lookup, the one read the loader
// declares (`reads.lookups`).
async function resolveWorktreePath(
  conversationId: string,
): Promise<string | null> {
  const found = await workspaceOfConversationLookup.run(conversationId);
  if (!found.found || !found.row.path) return null;
  return found.row.path;
}

// The watches of a conversation subscribed before its row (or its path) was
// written, parked until a load resolves its directory (`watchAllowFiles`). A
// parked watch that fails to open is reported and parked again: the next load
// that resolves the directory retries it.
const parked = createParkedWatches<string>({
  onOpenError: (conversationId, err) =>
    reportServerError({
      message: `[allow-files] the bypass-file watch of conversation ${conversationId} failed to open — its BYPASS chip hears no change until a load retries it: ${err instanceof Error ? err.message : String(err)}`,
      stack: err instanceof Error ? (err.stack ?? null) : null,
      errorType: "AllowFilesWatchOpenError",
    }),
});

// The loader's resolve: a directory found opens the watches parked on the
// conversation, so the load its row's insert re-ran opens the watch too.
async function worktreePathOf(conversationId: string): Promise<string | null> {
  const path = await resolveWorktreePath(conversationId);
  if (path !== null) parked.resolved(conversationId, path);
  return path;
}

async function loadAllowFiles(conversationId: string): Promise<AllowFiles> {
  const worktreePath = await worktreePathOf(conversationId);
  // No worktree means no guard runs there, so no bypass can be in effect.
  if (!worktreePath) return { allowFiles: [] };
  const present = await Promise.all(
    BYPASS_TOKENS.map(async (name) =>
      (await Bun.file(join(worktreePath, name)).exists()) ? name : null,
    ),
  );
  return { allowFiles: present.filter((name) => name !== null) };
}

// The bypass files sit at the worktree root, so a children-scope watch of it
// is all this needs. It goes through the shared dir hub, so it rides the
// checkout watch edited-files / git-status already hold on the same worktree
// rather than opening a second native watch over it. A conversation whose
// directory is not written yet parks the watch: the load the row's insert
// re-runs (the lookup's route) opens it.
function watchAllowFiles(
  conversationId: string,
  notify: () => void,
): Promise<() => void> {
  return parked.watch(
    conversationId,
    () => resolveWorktreePath(conversationId),
    async (worktreePath) => {
      const release = await acquireDirWatch({
        dir: worktreePath,
        scope: "children",
        onChange: (events) => {
          if (events.some((e) => BYPASS_TOKENS.includes(basename(e.path))))
            notify();
        },
      });
      // A file created between the first load and the watch starting produced
      // no event; one re-read closes that gap (a parked open's own notify
      // follows it, folded into the same flush).
      notify();
      return release;
    },
    notify,
  );
}

export const allowFilesServed = serveValue(allowFiles, {
  source: "external",
  changes: "notified",
  // Only a write the lookup reads (its columns, its conversation's row) re-runs
  // a tuple: a conversation's turn writes none of them.
  reads: {
    tables: [],
    lookups: [workspaceOfConversationLookup.read<{ id: string }>((p) => p.id)],
    reason:
      "each tuple resolves its conversation's worktree path (conversations → attempts) before checking the bypass files on disk, and the watch resolves it the same way; only the lookup's columns can move which directory a tuple reads",
  },
  loader: ({ id }) => loadAllowFiles(id),
  // One hub watch per watched conversation, for as long as it has a
  // subscriber. The start stays SYNC: an async start is awaited on the
  // subscribe path, so it would hold the sub-ack behind the watch opening on
  // the worktree root. The watch is instead held as a promise, and the release
  // chains on it — the last subscriber can leave before it resolves.
  whileSubscribed: ({ id }, notify) => {
    const watch = watchAllowFiles(id, notify);
    return () => {
      void runTracked("allow-files:unwatch", async () => {
        const release = await watch;
        release();
      });
    };
  },
});
