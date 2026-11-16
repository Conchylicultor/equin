import { z } from "zod";
import type { TranscriptSegment } from "@plugins/framework/plugins/cli/plugins/op-runtime/core";

/**
 * The report kind string, spelled once: the server registers its `ReportKind`
 * under it and the web dispatches its `Reports.KindView` on it.
 */
export const BUILD_FAILED_KIND = "build-failed";

/** The most lines of the failing stretch a report keeps. */
const TAIL_MAX = 40;
/** The longest error line kept (a stack frame or a path can be very long). */
const ERROR_MAX = 300;

/**
 * What failed in one build of main, read back from the run's transcript, plus
 * the run it was read from. The row keeps the LATEST occurrence's payload; its
 * identity is {@link buildFailureSignature} — what failed, never which run.
 */
export const BuildFailedPayloadSchema = z.object({
  /** The failed run (`build-…`) — the latest one with this failure. */
  runId: z.string(),
  /** The commit it built, `null` when the ledger row named none. */
  commit: z.string().nullable(),
  /** The compositions it built (main's own app, `website`, …). */
  targets: z.array(z.string()).max(32),
  /** `auto` (main's convergence run) or `manual` (the Build button). */
  trigger: z.string(),
  exitCode: z.number().int(),
  /**
   * The printed step block that failed (`checks`, `web artifacts`), or `null`
   * when the build failed outside every step — a crash or an abort before its
   * own verdict, a backend that never came up.
   */
  step: z.string().nullable(),
  /** The checks that failed, when the failing step ran checks. */
  checks: z.array(z.string()).max(64),
  /** The first error line of the failing stretch, `null` when it printed none. */
  error: z.string().nullable(),
  /** The failing stretch's last lines, oldest first. */
  tail: z.array(z.string()).max(TAIL_MAX),
  /** The run's transcript is gone (pruned) or was never written. */
  noTranscript: z.boolean(),
});
export type BuildFailedPayload = z.infer<typeof BuildFailedPayloadSchema>;

/** The part of the payload read from the transcript. */
export type BuildFailure = Pick<
  BuildFailedPayload,
  "step" | "checks" | "error" | "tail"
>;

/**
 * A check that failed, as the check runner prints it in its step block
 * (`tooling/checks`' runner and transcript: `• <id> ... FAIL[ (provenance)]`).
 */
const FAILED_CHECK = /^• (\S+) \.\.\. FAIL\b/;

/**
 * A line that states an error: `error: …` / `Error: …` / `ERROR: …` (bun's
 * uncaught-error line, a thrown Error's message, the build's own aborts), or a
 * named error class (`SnapshotPageError: …`, `TypeError: …`). Anchored at the
 * line's start, so a source excerpt (`176 |   throw new Error(`) or a stack
 * frame never matches.
 */
const ERROR_LINE =
  /^\s*(?:error|Error|ERROR)\b[:\s]|^\s*\w+(?:Error|Exception):\s/;

/** Where the build's verdict banner starts — everything after it is the summary, not the cause. */
const BANNER = /^╔/;

/**
 * What failed, read from a failed run's transcript segments
 * (`parseStepBlocks`): the first failed step block — its failing checks, its
 * first error line and its last lines — or, when every printed block passed,
 * the stretch of output the run ended in (a crash or abort before the verdict),
 * cut at the verdict banner.
 */
export function buildFailureOf(
  segments: readonly TranscriptSegment[],
): BuildFailure {
  const failed = segments.find((s) => s.kind === "step" && !s.success);
  if (failed !== undefined && failed.kind === "step") {
    const checks = failed.lines.flatMap((l) => {
      const m = FAILED_CHECK.exec(l);
      return m?.[1] !== undefined ? [m[1]] : [];
    });
    return {
      step: failed.label,
      checks: checks.slice(0, 64),
      error: firstErrorLine(failed.lines),
      tail: failed.lines.slice(-TAIL_MAX),
    };
  }
  const last = segments.at(-1);
  const lines = last?.kind === "output" ? beforeBanner(last.lines) : [];
  return {
    step: null,
    checks: [],
    error: firstErrorLine(lines),
    tail: lines.slice(-TAIL_MAX),
  };
}

function beforeBanner(lines: readonly string[]): string[] {
  const at = lines.findIndex((l) => BANNER.test(l));
  return (at < 0 ? lines : lines.slice(0, at)).filter((l) => l.trim() !== "");
}

function firstErrorLine(lines: readonly string[]): string | null {
  const line = lines.find((l) => ERROR_LINE.test(l));
  if (line === undefined) return null;
  const trimmed = line.trim();
  return trimmed.length > ERROR_MAX
    ? `${trimmed.slice(0, ERROR_MAX - 1)}…`
    : trimmed;
}

/**
 * An error line with what varies between two runs of the same failure taken
 * out: the checkout's absolute path (main's, or a worktree's) down to the
 * repo-relative one, commit hashes, and numbers (line:column, counts, sizes,
 * durations). Two builds failing the same way on different commits read alike.
 */
export function normalizeErrorLine(line: string): string {
  return (
    line
      // An ABSOLUTE path only (it starts the line or follows a space, quote or
      // paren): a repo-relative `plugins/a/plugins/b` is already what we want.
      .replace(
        /(^|[\s("'`])\/\S*?\/(plugins|gateway|web|cli|sidequests)\//g,
        "$1$2/",
      )
      .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>")
      .replace(/\d+(?:\.\d+)?/g, "N")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * The identity a failure is deduped on — WHAT failed, not which run: the
 * failing step, then its failing checks when it names any (a check's message
 * varies from commit to commit, its id does not), else its normalized error
 * line. A check that fails on five rebuilds in a row is one report counted
 * five times; a different check failing is a different report.
 */
export function buildFailureSignature(
  d: Pick<BuildFailedPayload, "step" | "checks" | "error" | "noTranscript">,
): string {
  const where = d.step ?? "outside any step";
  if (d.checks.length > 0)
    return `${where}: ${[...d.checks].sort().join(", ")}`;
  if (d.error !== null) return `${where}: ${normalizeErrorLine(d.error)}`;
  return d.noTranscript ? `${where}: no transcript` : where;
}

/**
 * The one-line summary — the report row's `message`, and the KindView's text:
 * `main build failed in checks: type-check`.
 */
export function buildFailedMessage(d: BuildFailedPayload): string {
  const where = d.step === null ? "outside any step" : `in ${d.step}`;
  const what =
    d.checks.length > 0
      ? d.checks.join(", ")
      : (d.error ?? (d.noTranscript ? "(no transcript)" : "(no error line)"));
  return `main build failed ${where}: ${what}`;
}
