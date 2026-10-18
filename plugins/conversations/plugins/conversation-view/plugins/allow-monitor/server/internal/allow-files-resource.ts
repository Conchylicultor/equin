import { basename, join } from "path";
import { serveValue } from "@plugins/network/plugins/live/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import {
  acquireDirWatch,
  type DirWatchRelease,
} from "@plugins/infra/plugins/file-watcher/server";
import { BYPASS_TOKENS } from "@plugins/framework/plugins/tooling/plugins/guards/core";
import { findWorkspaceOfConversation } from "@plugins/conversations/plugins/workspace/server";
import {
  _attempts,
  _conversations,
} from "@plugins/tasks/plugins/tasks-core/server";
import { allowFiles, type AllowFiles } from "../../shared";

// The directory the conversation's agent runs in (its attempt's worktree, or a
// scratch workspace's directory) — null for an unknown conversation or one with
// no path yet.
async function worktreePathOf(conversationId: string): Promise<string | null> {
  const found = await findWorkspaceOfConversation(conversationId);
  if (!found.found || !found.workspace.path) return null;
  return found.workspace.path;
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
// rather than opening a second native watch over it.
async function watchAllowFiles(
  conversationId: string,
  notify: () => void,
): Promise<DirWatchRelease | null> {
  const worktreePath = await worktreePathOf(conversationId);
  if (!worktreePath) return null;
  const release = await acquireDirWatch({
    dir: worktreePath,
    scope: "children",
    onChange: (events) => {
      if (events.some((e) => BYPASS_TOKENS.includes(basename(e.path))))
        notify();
    },
  });
  // A file created between the first load and the watch starting produced no
  // event; one re-read closes that gap.
  notify();
  return release;
}

export const allowFilesServed = serveValue(allowFiles, {
  source: "external",
  changes: "notified",
  reads: {
    tables: [_conversations, _attempts],
    reason:
      "each tuple resolves its conversation's worktree path (conversations → attempts) before checking the bypass files on disk, and the watch resolves it the same way; a write to any conversation or attempt row may move which directory a tuple reads — whole-table until the path is a param or a db-served value",
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
        release?.();
      });
    };
  },
});
