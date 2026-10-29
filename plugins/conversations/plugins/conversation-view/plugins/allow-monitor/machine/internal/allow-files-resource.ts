import { basename, join } from "path";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { acquireEventualDirWatch } from "@plugins/infra/plugins/file-watcher/machine";
import { BYPASS_TOKENS } from "@plugins/framework/plugins/tooling/plugins/guards/core";
import { conversationWorkspacesServed } from "@plugins/tasks/plugins/tasks-core/server";
import { conversationWorkspaceOf } from "@plugins/tasks/plugins/tasks-core/core";
import { allowFiles, type AllowFiles } from "../../core";

// The directory the conversation's agent runs in (its attempt's worktree, or a
// scratch workspace's directory), from its followed workspace row
// (`followed.ws`, below) — null for a conversation with no row or no path yet.
function worktreePathOf(
  ws: readonly { readonly worktreePath: string }[],
): string | null {
  return conversationWorkspaceOf(ws)?.worktreePath ?? null;
}

function reportWatchOpenError(conversationId: string, err: unknown): void {
  reportServerError({
    message: `[allow-files] the bypass-file watch of conversation ${conversationId} failed to open — its BYPASS chip hears no change until a write moves its workspace row or it is subscribed again: ${err instanceof Error ? err.message : String(err)}`,
    stack: err instanceof Error ? (err.stack ?? null) : null,
    errorType: "AllowFilesWatchOpenError",
  });
}

async function loadAllowFiles(
  worktreePath: string | null,
): Promise<AllowFiles> {
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
// rather than opening a second native watch over it. The path is written
// before the directory exists (the checkout is the spawn job's), and a reaped
// worktree's is gone while its conversation can still be open — so the watch
// is an eventual one: it hears the directory appear or go, and either
// re-reads.
async function watchAllowFiles(
  worktreePath: string,
  notify: () => void,
): Promise<() => void> {
  const release = await acquireEventualDirWatch({
    dir: worktreePath,
    scope: "children",
    onChange: (events) => {
      if (
        events.some(
          (e) =>
            e.path === worktreePath || BYPASS_TOKENS.includes(basename(e.path)),
        )
      )
        notify();
    },
  });
  // A file created between the load and the watch starting produced no
  // event; one re-read closes that gap.
  notify();
  return release;
}

export const allowFilesServed = serveValue(allowFiles, {
  source: "external",
  changes: "notified",
  // The conversation's workspace row — tasks-core's `conversationWorkspaces`,
  // `{ ids: [id] }` — the one Postgres read the loader and the watch make:
  // only a write that moves it (the conversation's `attempt_id`, its
  // attempt's `worktree_path`) re-runs a tuple, and only that conversation's
  // (an attempt's write: the conversations of that attempt). A conversation's
  // turn reaches none.
  follows: (follow) => ({
    ws: follow(conversationWorkspacesServed, ({ id }) => ({ ids: [id] })),
  }),
  loader: (_p, { followed }) => loadAllowFiles(worktreePathOf(followed.ws)),
  // One hub watch per watched conversation, for as long as it has a
  // subscriber, over the directory its followed row names: a conversation with
  // no directory yet (its row, or its path, not written) watches nothing, and
  // the framework re-starts the watch over the new row when a write moves it
  // (the follow's re-point) — so a worktree checked out after the first
  // subscribe is watched. The start stays SYNC: an async start is awaited on
  // the subscribe path, so it would hold the sub-ack behind the watch opening
  // on the worktree root. The watch is instead held as a promise, and the
  // release chains on it — the last subscriber can leave before it resolves.
  //
  // A watch that fails to open holds nothing: it is reported as it fails —
  // never left an unobserved rejection until the release — and its release
  // has nothing to give back.
  whileFollowing: {
    over: (followed) => worktreePathOf(followed.ws),
    start: ({ id }, { over: worktreePath, notify }) => {
      if (worktreePath === null) return () => {};
      const watch = watchAllowFiles(worktreePath, notify).then(
        (release) => ({ opened: true as const, release }),
        (err: unknown) => {
          reportWatchOpenError(id, err);
          return { opened: false as const };
        },
      );
      return () => {
        void runTracked("allow-files:unwatch", async () => {
          const held = await watch;
          if (held.opened) held.release();
        });
      };
    },
  },
});
