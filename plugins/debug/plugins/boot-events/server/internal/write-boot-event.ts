import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { getBootMode } from "@plugins/framework/plugins/server-core/core";
import type { Registration } from "@plugins/framework/plugins/server-core/core";
import type { BootLine } from "./schema";

// Writes the per-boot lines to the persisted `boot` log channel →
// ~/.equin/worktrees/<wt>/logs/boot.jsonl: one `start` line at the
// register phase, one `ready` line from `onReady` — or, when the process
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

const channel = defineLogSink({
  id: "boot",
  description:
    "Per-boot start/ready lines (boot-events): a start line at the register phase and a ready line at onReady, so a wedged-mid-boot backend is visible on cross-worktree timelines.",
});

function publish(line: BootLine): void {
  channel.publish(JSON.stringify(line));
}

// The register phase is documented "no I/O" — this token is the deliberate,
// single exception: one synchronous ~140-byte file append whose entire point
// is landing BEFORE the boot work (migrations, onReadyBlocking) that can
// wedge. Routing it through onReady would re-create the blind spot it exists
// to close.
//
// SERVE ONLY. An `exec` child (e.g. the nightly backup) runs this register
// phase too, under its parent's worktree name, but never reaches `onReady` —
// so its `start` would never pair with a `ready`, and the boot watchdog would
// report the healthy serving backend as wedged for as long as it stayed up.
//
// The same token arms the `exited` line: a boot that throws (a failed
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

export const bootStartRegistration: Registration = {
  register() {
    if (getBootMode() !== "serve") return;
    const worktree = runtimeNamespace();
    const processStartedAt = Math.round(performance.timeOrigin);
    publish({
      sampledAt: Date.now(),
      worktree,
      processStartedAt,
      phase: "start",
    });
    process.once("exit", () => {
      if (ready) return;
      const now = Date.now();
      publish({
        sampledAt: now,
        worktree,
        processStartedAt,
        exitedAt: now,
        phase: "exited",
      });
    });
  },
};

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
