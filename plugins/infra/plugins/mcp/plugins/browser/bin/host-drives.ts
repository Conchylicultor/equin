import { withE2eGrant } from "@plugins/infra/plugins/host/plugins/host-admission/server";
import type { AgentBrowserHostStatus } from "../core";
import type { HostToolResult } from "../shared/protocol";

/**
 * Admission for the calls that make Chromium work (`cost: "drive"` in
 * `shared/tools.ts`): each runs under one slot of the host-wide `e2e` pool —
 * the pool every e2e script run takes — so agents loading pages here and
 * scripts driving their own browsers share one bound on headless pages driven
 * at once, instead of the interactive half going uncounted.
 *
 * Per call, not per session: a session lives 10 idle minutes, and holding a
 * slot that long would starve every script. No op marker or op-log record: a
 * call is ~0.2 s, and would flood the banner. A call that queued says so in
 * its result, and the status counts what runs and waits.
 */

/** A wait shorter than this is the slot's own acquire, not a queue. */
const SAY_WAIT_MS = 1_000;

const drives = { running: 0, waiting: 0 };
let onChange: () => void = () => {};

export function wireDrives(hook: () => void): void {
  onChange = hook;
}

export function drivesSnapshot(): AgentBrowserHostStatus["drives"] {
  return { ...drives };
}

export async function withDriveSlot(
  call: () => Promise<HostToolResult>,
): Promise<HostToolResult> {
  let waitedMs = 0;
  let queued = false;
  const result = await withE2eGrant(
    {
      lane: "background",
      // The host drives tabs for every agent session at once — no one track.
      priority: "normal",
      max: 1,
      hooks: {
        onWaitStart() {
          queued = true;
          drives.waiting++;
          onChange();
        },
        onAcquired(ms) {
          waitedMs = ms;
          if (queued) drives.waiting--;
          queued = false;
          drives.running++;
          onChange();
        },
      },
    },
    async () => {
      try {
        return await call();
      } finally {
        drives.running--;
        onChange();
      }
    },
  ).finally(() => {
    // An acquire that failed while queued never reached `onAcquired`.
    if (queued) {
      drives.waiting--;
      onChange();
    }
  });
  if (waitedMs < SAY_WAIT_MS) return result;
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "text",
        text: `(Waited ${(waitedMs / 1000).toFixed(1)} s for a browser slot: the machine runs at most a few headless pages at once, e2e scripts included.)`,
      },
    ],
  };
}
