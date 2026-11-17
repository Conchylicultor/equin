import {
  readOpRecords,
  type OpProfiler,
} from "@plugins/debug/plugins/profiling/plugins/op-log/cli";
import type {
  WaitKind,
  WaitResult,
} from "@plugins/debug/plugins/profiling/plugins/op-log/core";
import type { WaitHolder, WaitOn } from "@plugins/installer/core";
import { installEventsOn, reportInstallWait } from "@plugins/installer/cli";

/**
 * The build's op profiler, whose waits are also reported to the install
 * running this build as one of its steps (installer/core `wait` events): the
 * op profiler is the one place every build wait is recorded (the build lock,
 * the duress gate, the host CPU grant), so the install's view of "waiting for
 * another task" cannot miss one the op log has. Outside an install the
 * profiler is returned as is.
 */
export function withInstallWaits(
  profiler: OpProfiler<"build">,
): OpProfiler<"build"> {
  if (!installEventsOn()) return profiler;
  let open: WaitOn | null = null;
  const start = (kind: WaitKind): void => {
    end();
    open = INSTALL_WAIT_OF[kind];
    reportInstallWait(
      "start",
      open,
      ...(open === "host-grant" ? optional(grantHolder()) : []),
    );
  };
  const end = (): void => {
    if (open === null) return;
    reportInstallWait("end", open);
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

/** What each op-log wait is, in the install's words. */
const INSTALL_WAIT_OF = {
  "build-lock": "lock",
  "push-mutex": "lock",
  "in-flight": "lock",
  "host-grant": "host-grant",
  // The duress gate holds a build for the machine's build slot too: to the
  // person installing, it is the same wait.
  "duress-valve": "host-grant",
} as const satisfies Record<WaitKind, WaitOn>;

function optional<T>(value: T | null): [T] | [] {
  return value === null ? [] : [value];
}

/**
 * Who holds the machine's build slot: the longest-running op that is working
 * (admitted, not parked in a wait of its own). Null when the op log names
 * none — the slot is then held by work the op log does not record.
 */
function grantHolder(): WaitHolder | null {
  const working = readOpRecords()
    .filter((r) => r.outcome === "running" && r.openWait === null)
    .sort((a, b) => a.grantedAt.localeCompare(b.grantedAt));
  const oldest = working[0];
  if (oldest === undefined) return null;
  return { op: oldest.opId, kind: oldest.kind, startedAt: oldest.grantedAt };
}
