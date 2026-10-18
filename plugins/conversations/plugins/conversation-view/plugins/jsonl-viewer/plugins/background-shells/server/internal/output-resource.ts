import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  readJsonlEventsFromChain,
  resolveConversationTranscriptPaths,
  transcriptChainReads,
  transcriptChainSignature,
} from "@plugins/conversations/plugins/transcript-watcher/server";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";
import { defineFileWatcher } from "@plugins/infra/plugins/file-watcher/server";
import { createSignedMemo } from "@plugins/infra/plugins/git/plugins/git-read-cache/server";
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
function outputFileIn(
  events: readonly JsonlEvent[],
  shellId: string,
): string | null {
  const launch = shellLaunchesIn(events).find((l) => l.shellId === shellId);
  if (launch === undefined) return null;
  assertShellOutputPath(launch.outputFile, shellId, shellOutputPathContext());
  return launch.outputFile;
}

// A signed memo is keyed by ONE string, and this value by a conversation plus a
// shell id. NUL occurs in neither, so it is the one separator that cannot collide.
const SEP = "\u0000";

const memoKey = (id: string, shellId: string): string =>
  `${id}${SEP}${shellId}`;

function parseMemoKey(key: string): { id: string; shellId: string } {
  const [id, shellId, ...rest] = key.split(SEP);
  if (id === undefined || shellId === undefined || rest.length > 0) {
    throw new Error(`[background-shells] malformed output memo key: ${key}`);
  }
  return { id, shellId };
}

/**
 * Each open room's resolved path, so the transcript chain is read once per
 * subscription rather than once per push. Only a FOUND path is kept: a launch
 * acknowledgement never changes once written, while "not found yet" can.
 * Entries live exactly as long as their room.
 */
const roomPaths = new Map<string, string>();

/**
 * What the value is read from — the one resolution both halves of the memo go
 * through. `file`: the shell's output file (the room's cached path, else
 * resolved from the transcript). `unknown`: the transcript records no such
 * launch, so the value is a function of the chain itself, signed over its files.
 */
type OutputTarget =
  { kind: "file"; path: string } | { kind: "unknown"; chain: string[] };

async function resolveTarget(key: string): Promise<OutputTarget> {
  const cached = roomPaths.get(key);
  if (cached !== undefined) return { kind: "file", path: cached };
  const { id, shellId } = parseMemoKey(key);
  const chain = await resolveConversationTranscriptPaths(id);
  const path = outputFileIn(await readJsonlEventsFromChain(chain), shellId);
  return path === null ? { kind: "unknown", chain } : { kind: "file", path };
}

// Signature and compute bound at ONE declaration site, as jsonl-events-cache.ts
// does: `revalidate` and the `loader` are the same function of the same inputs.
//
// The signature is `transcriptChainSignature` over the files the value is read
// from — the output file's `(path, lstat mtime, size)` (a missing file drops its
// triple, so `gone` signs differently), or, for an unknown shell, the chain's.
// While a room is open the path is cached, so the probe is one `lstat`: a FULL
// that changed nothing (a `conversations` write, say) costs a stat, not a 64 KB
// tail read and a frame. The probe always precedes the compute it labels, so a
// write landing between them leaves the stored signature OLDER than the value —
// the next probe misses and recomputes; never a stale value under a fresh one.
const outputMemo = createSignedMemo<ShellOutput>({
  name: "background-shell-output",
  signature: async (key) => {
    const target = await resolveTarget(key);
    return target.kind === "file"
      ? `file|${await transcriptChainSignature([target.path])}`
      : `unknown|${await transcriptChainSignature(target.chain)}`;
  },
  compute: async (key) => {
    const target = await resolveTarget(key);
    return target.kind === "file"
      ? readShellTail(target.path)
      : { kind: "unknown-shell" };
  },
});

export const shellOutputServed = serveValue(shellOutput, {
  source: "external",
  changes: "notified",
  // Resolving the output file reads the transcript chain from Postgres.
  reads: transcriptChainReads,
  loader: ({ id, shellId }) => outputMemo.get(memoKey(id, shellId)),
  revalidate: ({ id, shellId }) => outputMemo.signature(memoKey(id, shellId)),
  // Watch the one file while anyone is looking at it (see shellOutputWatcher).
  whileSubscribed: async ({ id, shellId }, notify) => {
    const key = memoKey(id, shellId);
    const target = await resolveTarget(key);
    // Unknown shell, or its directory is already gone: nothing to watch, and
    // the loader answers `unknown-shell` / `gone` on its own. The memo entry
    // the loader cached for this room still lives exactly as long as the room.
    if (target.kind === "unknown" || !existsSync(dirname(target.path))) {
      return () => outputMemo.evict(key);
    }
    const outputFile = target.path;
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
      outputMemo.evict(key);
      // The stop contract is synchronous; the unsubscribe runs detached, under
      // its own span, and a failure still surfaces as an unhandled rejection.
      void runTracked("background-shell-output:watcher-stop", () =>
        watcher.stop(),
      );
    };
  },
});
