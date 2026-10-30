import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { freezeBackend } from "../../shared/endpoints";

/** Let the response flush before the thread stops. */
const FREEZE_DELAY_MS = 200;

// Blocks the JS thread outright — no timer, no I/O, no answer — the way a sync
// syscall waiting on a macOS permission prompt does. Atomics.wait on a buffer
// nothing ever notifies sleeps the calling thread for exactly `seconds`.
export const handleFreeze = implement(freezeBackend, ({ body }) => {
  if (isMain())
    throw new HttpError(
      403,
      "refusing to freeze main — freeze a worktree backend to reproduce",
    );
  const ms = body.seconds * 1000;
  // A one-shot deferral so this response is sent before the thread blocks.
  setTimeout(() => {
    console.warn(
      `[backend-liveness] freezing this JS thread for ${ms}ms (debug trigger)`,
    );
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    console.warn("[backend-liveness] JS thread resumed after the debug freeze");
  }, FREEZE_DELAY_MS);
  return { pid: process.pid, freezesAtMs: Date.now() + FREEZE_DELAY_MS };
});
