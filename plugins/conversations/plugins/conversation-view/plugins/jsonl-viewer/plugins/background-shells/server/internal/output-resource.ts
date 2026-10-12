import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  readJsonlEventsFromChain,
  resolveConversationTranscriptPaths,
} from "@plugins/conversations/plugins/transcript-watcher/server";
import { defineFileWatcher } from "@plugins/infra/plugins/file-watcher/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { shellLaunchesIn, shellOutput, type ShellOutput } from "../../core";
import { assertShellOutputPath, shellOutputPathContext } from "./output-path";
import { readShellTail } from "./tail-read";

// The shell holds its output file open for its whole run, and macOS FSEvents
// reports a change only when the writer closes it — so `writesWhileOpen`
// (kqueue) is what makes the tail move while the command is still running. A
// `tasks/` dir holds a few hundred entries at most, well under the kqueue bound.
export const shellOutputWatcher = defineFileWatcher({
  name: "background-shells.output",
  description:
    "While a background shell's output is on screen, watches its tasks/ directory and pushes the new tail each time the shell writes to its output file.",
  // How long a burst of writes is coalesced into one push.
  debounceMs: 150,
  writesWhileOpen: true,
});

/**
 * The output file of shell `shellId` in conversation `id`, or `null` when the
 * conversation's transcript records no such background launch.
 *
 * The browser names the shell; the SERVER finds its file — from the same
 * transcript chain and the same fold the browser reads — and checks the path's
 * shape before anything opens it. No subscription can point this at a path.
 */
async function resolveOutputFile(
  id: string,
  shellId: string,
): Promise<string | null> {
  const paths = await resolveConversationTranscriptPaths(id);
  const events = await readJsonlEventsFromChain(paths);
  const launch = shellLaunchesIn(events).find((l) => l.shellId === shellId);
  if (launch === undefined) return null;
  assertShellOutputPath(launch.outputFile, shellId, shellOutputPathContext());
  return launch.outputFile;
}

const roomKey = (id: string, shellId: string): string =>
  `${id}\u0000${shellId}`;

/**
 * Each open room's resolved path, so the transcript chain is read once per
 * subscription rather than once per push. Only a FOUND path is kept: a launch
 * acknowledgement never changes once written, while "not found yet" can.
 * Entries live exactly as long as their room.
 */
const roomPaths = new Map<string, string>();

async function outputFileOf(
  id: string,
  shellId: string,
): Promise<string | null> {
  return roomPaths.get(roomKey(id, shellId)) ?? resolveOutputFile(id, shellId);
}

export const shellOutputServed = serveValue(shellOutput, {
  source: "external",
  changes: "notified",
  loader: async ({ id, shellId }): Promise<ShellOutput> => {
    const outputFile = await outputFileOf(id, shellId);
    if (outputFile === null) return { kind: "unknown-shell" };
    return readShellTail(outputFile);
  },
  // Watch the one file while anyone is looking at it (see shellOutputWatcher).
  whileSubscribed: async ({ id, shellId }, notify) => {
    const key = roomKey(id, shellId);
    const outputFile = await resolveOutputFile(id, shellId);
    // Unknown shell, or its directory is already gone: nothing to watch, and
    // the loader answers `unknown-shell` / `gone` on its own.
    if (outputFile === null || !existsSync(dirname(outputFile))) {
      return () => {};
    }
    const dir = dirname(outputFile);
    roomPaths.set(key, outputFile);
    const name = basename(outputFile);
    const watcher = await shellOutputWatcher.start({
      dirs: [dir],
      label: `${id} · ${shellId}`,
      onChange: (events) => {
        if (events.some((e) => basename(e.path) === name)) notify();
      },
    });
    return () => {
      roomPaths.delete(key);
      // The stop contract is synchronous; the unsubscribe runs detached, under
      // its own span, and a failure still surfaces as an unhandled rejection.
      void runTracked("background-shell-output:watcher-stop", () =>
        watcher.stop(),
      );
    };
  },
});
