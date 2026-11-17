import {
  readOpRecords,
  type OpProfiler,
} from "@plugins/debug/plugins/profiling/plugins/op-log/cli";
import type {
  OpRecord,
  WaitKind,
  WaitResult,
} from "@plugins/debug/plugins/profiling/plugins/op-log/core";
import type { WaitHolder, WaitOn } from "@plugins/installer/core";
import {
  installEventsOn,
  reportInstallResolved,
  reportInstallStall,
  reportInstallWait,
} from "@plugins/installer/cli";

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
  let watch: StallWatch | null = null;
  const start = (kind: WaitKind): void => {
    end();
    open = INSTALL_WAIT_OF[kind];
    const holder = open === "host-grant" ? grantHolder() : null;
    reportInstallWait("start", open, ...optional(holder));
    if (holder !== null) watch = watchHolder(holder.op, Date.now());
  };
  const end = (): void => {
    if (open === null) return;
    watch?.stop();
    watch = null;
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

// ── The stall rule: waiting on a holder that stopped making progress ─────────

/** How long the install waits for the build slot before it looks at the holder. */
export const STALL_WAIT_MS = 2 * 60_000;
/** How long the holder must have shown no progress to count as stuck. */
export const HOLDER_QUIET_MS = 10 * 60_000;

/**
 * When the holder last made progress, as the op log saw it: its newest step's
 * end (steps are placed by ms after the request), else when it got the slot.
 */
export function holderLastProgress(record: OpRecord): number {
  const base = Date.parse(record.requestedAt);
  return Math.max(
    Date.parse(record.grantedAt),
    ...record.steps.map((s) => base + s.startMs + s.durationMs),
  );
}

/**
 * The stall rule's verdict at `now`, for a wait on the build slot that began
 * at `waitStart`: stuck (symptom: waited past STALL_WAIT_MS; fact: the holder
 * is still running and showed no progress for HOLDER_QUIET_MS), or the next
 * instant it could become so — a deadline, re-armed only when the holder
 * moved, never a fixed-interval look.
 */
export function judgeHolder(
  record: OpRecord | undefined,
  waitStart: number,
  now: number,
):
  | { stuck: true; quietSince: number }
  | { stuck: false; recheckAt: number | null } {
  if (record === undefined || record.outcome !== "running")
    return { stuck: false, recheckAt: null };
  const quietSince = holderLastProgress(record);
  const due = Math.max(waitStart + STALL_WAIT_MS, quietSince + HOLDER_QUIET_MS);
  if (now >= due) return { stuck: true, quietSince };
  return { stuck: false, recheckAt: due };
}

interface StallWatch {
  stop(): void;
}

/** Watch the slot's holder while the build waits on it; report a stall once. */
function watchHolder(opId: string, waitStart: number): StallWatch {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let reported = false;
  const check = (): void => {
    timer = null;
    const record = readOpRecords().find((r) => r.opId === opId);
    const verdict = judgeHolder(record, waitStart, Date.now());
    if (verdict.stuck && record !== undefined) {
      reported = true;
      reportInstallStall(stallWords(record, verdict.quietSince));
      return;
    }
    if (!verdict.stuck && verdict.recheckAt !== null) arm(verdict.recheckAt);
  };
  const arm = (at: number): void => {
    timer = setTimeout(check, Math.max(0, at - Date.now()));
    timer.unref();
  };
  arm(waitStart + STALL_WAIT_MS);
  return {
    stop() {
      if (timer !== null) clearTimeout(timer);
      if (reported) reportInstallResolved();
    },
  };
}

/** "3 hours ago", "12 minutes ago". */
function ago(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 90) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.round(min / 60);
  return `${h} hour${h === 1 ? "" : "s"} ago`;
}

/** The stall's words (the installer message rules), short enough for one event. */
export function stallWords(
  record: OpRecord,
  quietSince: number,
  now: number = Date.now(),
): { title: string; text: string; evidence: string[] } {
  const started = ago(now - Date.parse(record.grantedAt));
  return {
    title: "The install is waiting for an older task",
    text: `equin builds one thing at a time. A ${record.kind} started ${started} holds the turn but stopped making progress ${ago(now - quietSince)}. Stopping it lets the install go on: Fix with Claude can, asking first.`,
    evidence: [
      `build slot held by ${record.opId} (${record.kind}, pid ${record.pid ?? "?"})`,
      `last progress ${new Date(quietSince).toISOString()}`,
    ],
  };
}
