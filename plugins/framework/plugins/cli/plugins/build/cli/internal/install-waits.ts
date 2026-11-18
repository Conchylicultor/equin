import type { OpProfiler } from "@plugins/debug/plugins/profiling/plugins/op-log/cli";
import type {
  WaitKind,
  WaitResult,
} from "@plugins/debug/plugins/profiling/plugins/op-log/core";
import { installEventsOn } from "@plugins/installer/cli";
import {
  reportHostGrantWait,
  reportLockWait,
  type OpenInstallWait,
} from "@plugins/installer/plugins/waits/cli";

/**
 * The build's op profiler, whose waits are also reported to the install
 * running this build as one of its steps (installer/core `wait` events): the
 * op profiler is the one place every build wait is recorded (the build lock,
 * the duress gate, the host CPU grant), so the install's view of "waiting for
 * another task" cannot miss one the op log has. Who holds it, and the stall
 * rule, are installer/waits'. Outside an install the profiler is returned as
 * is.
 */
export function withInstallWaits(
  profiler: OpProfiler<"build">,
): OpProfiler<"build"> {
  if (!installEventsOn()) return profiler;
  let open: OpenInstallWait | null = null;
  const start = (kind: WaitKind): void => {
    end();
    const on = INSTALL_WAIT_OF[kind];
    open =
      on === "host-grant" ? reportHostGrantWait() : reportLockWait(on.heldBy);
  };
  const end = (): void => {
    open?.end();
    open = null;
  };
  return {
    ...profiler,
    waitStart(kind, reason) {
      profiler.waitStart(kind, reason);
      start(kind);
    },
    waitEnd(result?: WaitResult) {
      profiler.waitEnd(result);
      end();
    },
    async wait(kind, fn) {
      start(kind);
      try {
        return await profiler.wait(kind, fn);
      } finally {
        end();
      }
    },
    grantHooks() {
      const hooks = profiler.grantHooks();
      return {
        ...hooks,
        onWaitStart() {
          hooks.onWaitStart?.();
          start("host-grant");
        },
        onAcquired(waitMs) {
          hooks.onAcquired?.(waitMs);
          end();
        },
      };
    },
    requeue() {
      end();
      profiler.requeue();
    },
  };
}

/**
 * What each op-log wait is, in the install's words: the machine's build slot,
 * or a lock held by another op of the kind named.
 */
const INSTALL_WAIT_OF = {
  "build-lock": { heldBy: "build" },
  "push-mutex": { heldBy: "push" },
  "in-flight": { heldBy: "build" },
  "host-grant": "host-grant",
  // The duress gate holds a build for the machine's build slot too: to the
  // person installing, it is the same wait.
  "duress-valve": "host-grant",
} as const satisfies Record<WaitKind, { heldBy: string } | "host-grant">;
