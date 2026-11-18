import type { ThreadCpuHandle } from "@plugins/packages/plugins/thread-cpu-clock/core";
import { HANG_HELD_MS } from "@plugins/reports/plugins/check-thread-stall/core";

// The verdict half of the hang watch (`hang-watch.ts`), pure: what the
// watchdog thread concludes from the main thread's beat count and its CPU
// clock, both read from outside it. Kept apart from the opener so the watchdog
// worker loads nothing but this and the clock while it waits.

/**
 * How often the main thread bumps its beat — one `Atomics.add` on a shared
 * counter from an ordinary timer, so a beat proves the event loop ran a timer.
 */
export const HANG_BEAT_MS = 1_000;

/** How often the watchdog reads the beat and the clock. */
export const HANG_POLL_MS = 5_000;

/** What the main thread hands its watchdog worker (`workerData`). */
export interface HangWatchData {
  /** One Int32 slot: the beat count. */
  beats: SharedArrayBuffer;
  /** The main thread's CPU clock, readable from the worker. */
  thread: ThreadCpuHandle & { supported: true };
  pid: number;
  runId: string;
  worktree: string;
  transcript: string | null;
  /** `Date.now()` when the watch opened — the run's start, near enough. */
  openedAt: number;
}

/** The watchdog's memory: the last beat it saw, and the clocks at that moment. */
export interface HangJudge {
  beats: number;
  cpuAtBeatMs: number;
  beatSeenAt: number;
}

export type HangVerdict =
  /** The main thread ran a timer since the last look. */
  | { kind: "alive" }
  /**
   * No beat since `silentMs` ago, during which the thread ran on a core for
   * `heldMs` — under `HANG_HELD_MS`, so it may yet yield (a long sync stretch,
   * or a starved thread that has hardly run at all).
   */
  | { kind: "silent"; heldMs: number; silentMs: number }
  /** No beat, and the thread has HELD its core `HANG_HELD_MS` meanwhile. */
  | { kind: "hung"; heldMs: number; silentMs: number };

export function createHangJudge(
  beats: number,
  cpuMs: number,
  now: number,
): HangJudge {
  return { beats, cpuAtBeatMs: cpuMs, beatSeenAt: now };
}

/**
 * One look. Judged on the main thread's OWN CPU time since its last beat,
 * never on wall time: a thread the OS does not schedule (background priority
 * on a host under duress) accrues it only as fast as it runs, so a slow pass
 * is never hung however long it takes, and a thread spinning in a loop that
 * never yields is, whatever the host is doing. A thread blocked in a syscall
 * accrues nothing either — it is not judged here (a wait has no CPU to tell
 * a hang from a slow peer by).
 *
 * The clocks are read when the watchdog SEES a beat, up to `HANG_POLL_MS`
 * after it happened, so `heldMs` can only undercount — never call a thread
 * hung early.
 */
export function judgeHang(
  judge: HangJudge,
  beats: number,
  cpuMs: number,
  now: number,
): HangVerdict {
  if (beats !== judge.beats) {
    judge.beats = beats;
    judge.cpuAtBeatMs = cpuMs;
    judge.beatSeenAt = now;
    return { kind: "alive" };
  }
  const heldMs = Math.round(cpuMs - judge.cpuAtBeatMs);
  const silentMs = Math.round(now - judge.beatSeenAt);
  return heldMs >= HANG_HELD_MS
    ? { kind: "hung", heldMs, silentMs }
    : { kind: "silent", heldMs, silentMs };
}

/**
 * The main thread's part of a macOS `sample` capture: its call tree, outermost
 * first, cut to `maxLines` from the DEEP end — a loop's leaf is what names it,
 * and the tree's top is the same few runtime frames on every capture.
 *
 * `sample` writes one `Call graph:` section with a block per thread, each
 * headed by `<count> Thread_<id>` and, for the main thread,
 * `DispatchQueue_1: com.apple.main-thread`; the block ends at the next
 * thread's header or at the blank line that closes the section.
 */
export function mainThreadOfSample(text: string, maxLines: number): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex(
    (line) => /^\s+\d+ Thread_/.test(line) && line.includes("main-thread"),
  );
  if (start === -1) return [];
  const block: string[] = [lines[start]!.trimEnd()];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || /^\s{4}\d+ Thread_/.test(line)) break;
    block.push(line.trimEnd());
  }
  if (block.length <= maxLines) return block;
  // The header, a marker for what is cut, and the deepest frames: maxLines in all.
  const kept = Math.max(1, maxLines - 2);
  return [
    block[0]!,
    `  … ${block.length - 1 - kept} outer frames`,
    ...block.slice(-kept),
  ];
}
