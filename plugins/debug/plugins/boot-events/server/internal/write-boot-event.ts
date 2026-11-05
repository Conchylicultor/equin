import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { openDynamicSink } from "@plugins/infra/plugins/file-sink/core";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import {
  channelFileSink,
  logEnvelope,
  logsDirFor,
} from "@plugins/primitives/plugins/log-channels/plugins/log-files/server";
import type { BootLine } from "./schema";

// Writes the per-boot lines to the persisted `boot` log channel →
// ~/.equin/worktrees/<wt>/logs/boot.jsonl: one `start` line as the process
// starts, one `ready` line from `onReady` — or, when the process
// exits before it, one `exited` line from its `exit` event. The two pair by
// processStartedAt (readBootEvents), so a backend that wedges during
// migrations / onReadyBlocking leaves an unpaired start — visible on the
// timeline exactly during deploy-restart bursts, previously a blind spot.
//
// A log-channel line, not a DB table: no migration, survives DB re-forks, and
// stays readable from the main backend's disk scan even while this backend is
// wedged. Bounding: the file sink already rotates every channel file at a
// 128 MB cap — at two ~140-byte lines per boot that is effectively unbounded
// history, so no custom rotation here.

const BOOT_CHANNEL = {
  id: "boot",
  description:
    "Per-boot start/ready lines (boot-events): a start line as the serving process starts (before its plugin imports) and a ready line at onReady, so a wedged-mid-boot backend is visible on cross-worktree timelines.",
};
const channel = defineLogSink(BOOT_CHANNEL);

function publish(line: BootLine): void {
  channel.publish(JSON.stringify(line));
}

// The `start` line is the first thing a serving backend writes, before it
// imports its plugin graph: `writeBootStartEvent`, called by server-core's
// `bin/index.ts` beside its `boot-start` checkpoint. It used to be written in
// the register phase, which runs only once every plugin is imported — under
// load a cold import took 60–100 s (2026-11-04), so a boot the gateway killed
// at its deadline while still importing left no line, and the watchdog and
// the timeline read its predecessor as the latest attempt. That early, no
// host service is up yet (`defineLogSink` resolves its file through one), so
// it appends through the channel's file sink itself — the same memoised sink
// (`channelFileSink` is one per channel id) and envelope the desktop's log
// persistence writes this channel's later lines through.
//
// SERVE ONLY, by construction: only the serving entry point calls it. An
// `exec` child (e.g. the nightly backup) runs under its parent's worktree name
// but never reaches `onReady`, so its `start` would never pair with a `ready`,
// and the boot watchdog would report the healthy serving backend as wedged.
//
// The same call arms the `exited` line: a boot that throws (a failed
// migration, a boot assert) exits before `ready`, and without a terminal line
// it reads exactly like a wedge — the boot watchdog filed one, its un-ready
// time running until the next build's boot. The `exit` listener is
// synchronous (Bun runs it on a throw out of the boot as on process.exit); a
// signal kill runs no listener, so a backend killed mid-boot stays "never
// ready", which is what it is.
//
// The crash itself is a report too — armed by this plugin's machine half
// (`machine/internal/boot-crash.ts`), since filing it needs the computer.
let ready = false;

export function writeBootStartEvent(): void {
  const worktree = runtimeNamespace();
  const processStartedAt = Math.round(performance.timeOrigin);
  const file = channelFileSink(BOOT_CHANNEL);
  const append = (line: BootLine): void =>
    file.append(
      logEnvelope({
        t: line.sampledAt,
        stream: "stdout",
        line: JSON.stringify(line),
      }),
    );
  append({ sampledAt: Date.now(), worktree, processStartedAt, phase: "start" });
  process.once("exit", () => {
    if (ready) return;
    const now = Date.now();
    append({
      sampledAt: now,
      worktree,
      processStartedAt,
      exitedAt: now,
      phase: "exited",
    });
  });
}

export function writeBootReadyEvent(): void {
  ready = true;
  const now = Date.now();
  publish({
    sampledAt: now,
    worktree: runtimeNamespace(),
    processStartedAt: Math.round(performance.timeOrigin),
    readyAt: now,
    phase: "ready",
  });
}

/**
 * Settle `worktree`'s never-ready boot `processStartedAt` as dead by `deadBy`:
 * the one boot line written by another process — the boot watchdog, on main,
 * once the gateway shows the process is gone (killed at its readiness
 * deadline, or replaced). A SIGKILL leaves no line of its own, so without this
 * the boot read as open forever (see `schema.ts`). Appended to that
 * worktree's own `boot.jsonl` through the same bounded file sink a channel
 * file is written with (`openDynamicSink`: a per-worktree path, not this
 * process's), so the boot's whole history stays in one file.
 */
export function writeBootDeadEvent(
  worktree: string,
  processStartedAt: number,
  deadBy: number,
): void {
  const line: BootLine = {
    sampledAt: Date.now(),
    worktree,
    processStartedAt,
    deadBy,
    phase: "dead",
  };
  openDynamicSink(logsDirFor(worktree), BOOT_CHANNEL.id).append(
    logEnvelope({
      t: line.sampledAt,
      stream: "stdout",
      line: JSON.stringify(line),
    }),
  );
}
