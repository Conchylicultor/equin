import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CheckResult } from "@plugins/framework/plugins/tooling/core";
import {
  pruneWorktreeCheckArtifacts,
  worktreeArtifacts,
} from "@plugins/infra/plugins/paths/core";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import {
  STALL_KIND_LABELS,
  STALL_KINDS,
  type OwnerShare,
  type StallKind,
} from "./thread-attribution";
import type { StallCpu, ThreadSummary } from "./thread-watch";

/**
 * One settled check, as the transcript renders it. The runner's own outcome type
 * carries more (the `Check` object, timings, the wall start) — none of which the
 * file shows, so this asks only for what it prints.
 */
export interface TranscriptOutcome {
  checkId: string;
  result: CheckResult;
  cached: boolean;
  /** The run this verdict was adopted from (`CheckOutcome.sharedFrom`). */
  sharedFrom: string | null;
  observations: { line: string; stream: "stdout" | "stderr" }[];
}

/**
 * Where a settled check's verdict came from, as the suffix of its result line:
 * ` (shared with run <id>)` when this run joined another run's in-flight check,
 * ` (cached)` for an ordinary cache hit, nothing when it ran here. One function
 * for the console and the transcript, so the two cannot word it differently.
 */
export function provenance(cached: boolean, sharedFrom: string | null): string {
  if (sharedFrom !== null) return ` (shared with run ${sharedFrom})`;
  return cached ? " (cached)" : "";
}

/** Indent a possibly-multi-line block by two spaces, every line. */
function indent(text: string): string {
  return `  ${text.split("\n").join("\n  ")}`;
}

/**
 * One settled check's block: the result line, the check's own `ctx.log`
 * observations, and — for a non-passing result — its full message and hint.
 *
 * Pure, and deliberately NOT shared with the console renderer: the console
 * truncates a huge message to protect an agent's context window, which is a
 * console concern and the very reason this file exists. Nothing here is elided.
 */
export function renderOutcomeBlock(outcome: TranscriptOutcome): string[] {
  const { checkId, result, cached, sharedFrom, observations } = outcome;
  const lines: string[] = [];

  if (result.ok) {
    lines.push(`• ${checkId} ... ok${provenance(cached, sharedFrom)}`);
  } else if (result.inconclusive) {
    lines.push(
      `⚠ ${checkId} ... inconclusive — ${result.message.split("\n")[0]}`,
    );
  } else {
    lines.push(`• ${checkId} ... FAIL${provenance(false, sharedFrom)}`);
  }

  for (const { line } of observations) lines.push(indent(line));

  if (!result.ok) {
    lines.push(indent(result.message));
    if (result.hint) lines.push(`  hint: ${result.hint}`);
  }

  return lines;
}

/** `1234` → `1.2 s`. One decimal: a stall is ≥ 1 s, so milliseconds are noise. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "–";
}

/** `owner 61%, owner 22%` over a tally's own total. */
function headline(owners: OwnerShare[], total: number, n: number): string {
  return owners
    .slice(0, n)
    .map((o) => `${o.owner} ${percent(o.samples, total)}`)
    .join(", ");
}

/**
 * What an owner that pools many sources was made of (the evaluated plugins
 * under `import`), as shares of that owner. Nothing for every other owner.
 */
function detailLines(o: OwnerShare): string[] {
  if (o.detail.length === 0) return [];
  const parts = o.detail.map(
    (d) => `${d.name} ${percent(d.samples, o.samples)}`,
  );
  return [`          of which: ${parts.join(", ")}`];
}

/** The longest stall's `lateMs` — the part of a stall the thread was known busy. */
function longestStallMs(thread: ThreadSummary): number {
  return Math.max(0, ...thread.stalls.map((s) => s.lateMs));
}

/**
 * `blocking I/O 72%, process start 9%, CPU 15%, module load 4%` — every
 * nonzero kind over the stall's own sample count, busiest first. What a
 * stall's owner table can't show on its own: whether the thread was stuck in
 * a syscall or just running ordinary JS.
 */
function kindsLine(kinds: Record<StallKind, number>, total: number): string {
  return STALL_KINDS.filter((kind) => kinds[kind] > 0)
    .sort((a, b) => kinds[b] - kinds[a])
    .map((kind) => `${STALL_KIND_LABELS[kind]} ${percent(kinds[kind], total)}`)
    .join(", ");
}

/**
 * `1.2 s user + 0.3 s system (13% of 7.4 s stalled)` — how much of the
 * stall's known-busy window (`lateMs`, never `durationMs` — see
 * `ThreadStall.lateMs`) the PROCESS spent on a CPU, versus blocked in the
 * kernel or simply not scheduled. "The process", not "the main thread":
 * `StallCpu` is process-wide (see its doc) — a Worker running concurrently
 * (`type-check`'s own) would inflate this.
 */
function cpuLine(cpu: StallCpu, lateMs: number): string {
  const totalMs = cpu.userMs + cpu.systemMs;
  return (
    `${seconds(cpu.userMs)} user + ${seconds(cpu.systemMs)} system ` +
    `(${percent(totalMs, lateMs)} of ${seconds(lateMs)} stalled)`
  );
}

/**
 * The run's thread block: a summary line, who used the thread over the whole
 * run, and one entry per stall with its owners and a real stack for each. This
 * is the full-detail copy — the progress log keeps 3 owners and 5 frames per
 * stall, the console one line.
 *
 * Rendered even when nothing stalled: the whole-run table and the longest late
 * tick are evidence on their own (a longest tick of 300 ms rules out one long
 * block). Milliseconds per owner appear only when a stall measured the
 * sampler's rate; without one, shares are all that can be said.
 */
/**
 * The thread block's first-line prefix. The one marker `verdictSection` finds
 * the block by, so the writer and the reader cannot drift apart.
 */
const THREAD_BLOCK_HEAD = "thread: ";

export function renderThreadBlock(thread: ThreadSummary): string[] {
  const lines: string[] = [];
  const rate = thread.rateHz;
  const stalledPart =
    thread.stallCount === 0
      ? "no stall"
      : `${thread.stallCount} stall${thread.stallCount === 1 ? "" : "s"}, ` +
        `${seconds(thread.stalledMs)} stalled (longest ${seconds(longestStallMs(thread))})`;
  lines.push(
    `${THREAD_BLOCK_HEAD}${stalledPart}; longest late tick ${thread.longestLateMs}ms; ` +
      `${thread.samples} samples${rate === null ? "" : ` at ${rate} Hz`}; ` +
      `watch cost ${thread.selfMs}ms`,
  );

  lines.push("  who used the thread (whole run):");
  for (const o of thread.owners) {
    const ms = o.ms === null ? "" : `~${seconds(o.ms)}  `;
    lines.push(
      `    ${percent(o.samples, thread.samples).padStart(4)}  ${ms}${o.owner}`,
      ...detailLines(o),
    );
  }

  thread.stalls.forEach((stall, i) => {
    lines.push(
      `  stall ${i + 1} at +${seconds(stall.offsetMs)}: ${seconds(stall.lateMs)}, ` +
        `${stall.samples} samples, ${stall.running.length} ` +
        `check${stall.running.length === 1 ? "" : "s"} in flight`,
    );
    lines.push(`    waiting on: ${kindsLine(stall.kinds, stall.samples)}`);
    lines.push(`    on CPU: ${cpuLine(stall.cpu, stall.lateMs)}`);
    if (stall.running.length > 0)
      lines.push(`    running: ${stall.running.join(", ")}`);
    if (stall.bootstrap.length > 0)
      lines.push(`    bootstrap: ${stall.bootstrap.join(", ")}`);
    for (const o of stall.owners) {
      lines.push(
        `    ${percent(o.samples, stall.samples).padStart(4)}  ${o.owner}`,
        ...detailLines(o),
        ...o.example.map((frame) => `          ${frame}`),
      );
    }
  });

  return lines;
}

/**
 * The console's one line about the thread, or null when nothing stalled. It
 * never changes the verdict, and prints on a passing run too: it stays loud
 * until the code that stalls the thread is fixed, which is the point of it.
 */
export function renderStallLine(
  thread: ThreadSummary,
  detailsPath: string | null,
): string | null {
  if (thread.stallCount === 0) return null;
  // Ranked by STALL time (every stall window together), not whole-run time:
  // the line is about what stalled the thread, and the whole-run table — which
  // also counts work that yielded — is in the transcript.
  const stallSamples = thread.stalls.reduce((sum, s) => sum + s.samples, 0);
  const owners = headline(thread.stallOwners, stallSamples, 2);
  return (
    `⚠ check thread stalled ${seconds(longestStallMs(thread))} ` +
    `(longest of ${thread.stallCount}, ${seconds(thread.stalledMs)} total)` +
    (owners ? ` — mostly ${owners}` : "") +
    "." +
    (detailsPath ? ` Details: ${detailsPath}` : "")
  );
}

/** A live run's transcript: the settle-time writer plus its terminal write. */
export interface CheckTranscript {
  /** Where it is being written — the pointer the console hands the reader. */
  readonly path: string;
  /** Record one settled check. Called as each settles, never from a print loop. */
  record(outcome: TranscriptOutcome): void;
  /**
   * Close the run: append `trailer`, then the thread block (the STOP banner,
   * the inconclusive note, or whatever ended the run early), then the `done`
   * line, then prune the family. `thread` is what `ProgressRun.finish()`
   * returned, which is why the runner finishes the progress run first.
   */
  finish(trailer: string[], allOk: boolean, thread: ThreadSummary): void;
}

/**
 * Open this run's transcript and write its header.
 *
 * The header is written HERE — before a single check runs — because the whole
 * defect this replaces was a file that only existed once every check had
 * settled: a run killed mid-checks wrote nothing and left its predecessor's file
 * behind, so the killed run's own verdict pointed a reader at another run's
 * failures. A file that exists from the first moment cannot do that, and it is
 * readable WHILE the run is in flight, which is exactly when a slow run is
 * interesting.
 *
 * Whole-file re-materialization (`writeFileSync`), never an append: append-mode
 * writers are reserved for the file-sink primitive (`no-adhoc-file-sink`), whose
 * shape — `.jsonl`, 128 MB rotation — does not fit a per-run text artifact. A
 * full run is ~155 lines, so re-writing it per settle is nothing; the family's
 * growth bound is the prune, as with every other per-run artifact.
 */
export function openCheckTranscript(args: {
  worktree: Namespace;
  runId: string;
  scope: string | null;
  /** The ids the caller named, or null for "every check". */
  requested: string[] | null;
}): CheckTranscript {
  const path = worktreeArtifacts.checkLog(args.worktree, args.runId);
  const startedAt = performance.now();

  // Completion-ordered, while the console and build.log stay selection-ordered.
  // Deliberate: this file is read while the run is still going, so "what has
  // finished so far" is the useful order — and a stable one, since a line is
  // only ever written after the check it describes has settled.
  const lines: string[] = [
    `check run ${args.runId}`,
    `  worktree: ${args.worktree}`,
    `  pid:      ${process.pid}`,
    `  scope:    ${args.scope ?? "all"}`,
    `  checks:   ${args.requested ? args.requested.join(", ") : "all"}`,
    `  started:  ${new Date().toISOString()}`,
    "",
  ];

  mkdirSync(dirname(path), { recursive: true });
  const flush = (): void => {
    writeFileSync(path, lines.join("\n") + "\n");
  };
  flush();

  return {
    path,
    record(outcome) {
      lines.push(...renderOutcomeBlock(outcome));
      flush();
    },
    finish(trailer, allOk, thread) {
      // The trailer sits with the outcomes it is about, ahead of the thread
      // block: `outcomes + trailer` is then the one contiguous section a
      // joined run replays (`verdictSection`).
      lines.push(...trailer);
      lines.push("", ...renderThreadBlock(thread));
      lines.push(
        "",
        `done — ${allOk ? "all ok" : "FAILED"} in ${Math.round(performance.now() - startedAt)}ms`,
      );
      flush();
      // Writing a new transcript is what trims the old ones — the same
      // convention every other per-run artifact follows. A killed run skips its
      // prune; the next completed run reaps it.
      pruneWorktreeCheckArtifacts(args.worktree);
    },
  };
}

/**
 * The part of a finished transcript that IS the run's verdict — what its
 * console showed: every settled check's block, the trailer and the `done`
 * line. Not the header (a joiner names the run it joined itself) and not the
 * thread block (it profiles the leader's process, not the verdict). This is
 * what a run that joined another's in-flight check replays.
 *
 * Pure over the file's lines; `openCheckTranscript` is the writer it reads.
 */
export function verdictSection(lines: string[]): string[] {
  // The header always ends at its first blank line.
  const body = lines.slice(lines.indexOf("") + 1);
  const thread = body.findIndex((l) => l.startsWith(THREAD_BLOCK_HEAD));
  if (thread === -1) return body;
  const outcomes = body.slice(0, thread);
  while (outcomes.at(-1) === "") outcomes.pop();
  const done = body.findLast((l) => l.startsWith("done — "));
  return done === undefined ? outcomes : [...outcomes, "", done];
}

/** A run's transcript read back as its verdict section, or that it is gone. */
export function readTranscriptVerdict(
  path: string,
): { kind: "ok"; lines: string[] } | { kind: "missing" } {
  if (!existsSync(path)) return { kind: "missing" };
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  return { kind: "ok", lines: verdictSection(lines) };
}
