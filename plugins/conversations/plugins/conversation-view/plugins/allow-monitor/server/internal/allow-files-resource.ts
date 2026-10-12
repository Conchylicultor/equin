import { basename, join } from "path";
import { serveValue } from "@plugins/network/plugins/live/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import {
  acquireDirWatch,
  type DirWatchRelease,
} from "@plugins/infra/plugins/file-watcher/server";
import { BYPASS_TOKENS } from "@plugins/framework/plugins/tooling/plugins/guards/core";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import { allowFiles, type AllowFiles } from "../../shared";

async function loadAllowFiles(conversationId: string): Promise<AllowFiles> {
  const conversation = await getConversation(conversationId);
  // No worktree means no guard runs there, so no bypass can be in effect.
  if (!conversation?.worktreePath) return { allowFiles: [] };
  const worktreePath = conversation.worktreePath;
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
  const conversation = await getConversation(conversationId);
  const worktreePath = conversation?.worktreePath;
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
