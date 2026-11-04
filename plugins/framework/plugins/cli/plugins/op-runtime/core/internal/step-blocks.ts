/**
 * The build's step-block format, both ways: how a finished step is printed into
 * the run's transcript (`renderStepBlock`, used by the console printer in
 * `cli/build-output.ts`) and how a reader gets it back (`parseStepBlocks`, used
 * by the build pane). One module, so the printed shape and the parsed shape
 * cannot drift — the transcript is the build's only record, and these blocks
 * are the only structure it carries.
 *
 * A block is a header, then the step's lines, each quoted:
 *
 * ```
 * ── checks ✓ (25.8s) ───────────────────────────────────────
 * │ • boundary-rules ... ok (cached)
 * ```
 *
 * The `│ ` quote is what keeps a step's own output from reading as the build's
 * (a borrowed `✓ built` reads as `│ ✓ built`) — and, for the parser, what makes
 * a block unambiguous: a quoted line can never be a header.
 */

type Stream = "stdout" | "stderr";

/** One finished step as the build prints it: its lines, timing and verdict. */
export interface BuildStepLog {
  id: string;
  label: string;
  lines: Array<{ text: string; stream: Stream }>;
  durationMs: number;
  success: boolean;
}

/** The prefix every line of a step block carries. */
const QUOTE = "│ ";
/** The header's rule character, and the width the header is padded to. */
const RULE = "─";
const HEADER_WIDTH = 60;
const PASSED = "✓";
const FAILED = "✗";

/** `── <label> ✓|✗ (<seconds>s) ───…` — the label is anything up to the last icon. */
const HEADER = new RegExp(
  `^${RULE}${RULE} (.+) (${PASSED}|${FAILED}) \\((\\d+(?:\\.\\d+)?)s\\) ${RULE}*$`,
);

/**
 * One step's block, header first. Each line keeps its own stream tag so the
 * console still routes stderr to stderr.
 */
export function renderStepBlock(
  step: BuildStepLog,
): Array<{ text: string; stream: Stream }> {
  const icon = step.success ? PASSED : FAILED;
  const duration = (step.durationMs / 1000).toFixed(1);
  const header = `${RULE}${RULE} ${step.label} ${icon} (${duration}s) `;
  const pad = Math.max(0, HEADER_WIDTH - header.length);
  return [
    { text: header + RULE.repeat(pad), stream: "stdout" },
    ...step.lines.map((line) => ({
      text: `${QUOTE}${line.text}`,
      stream: line.stream,
    })),
  ];
}

/**
 * A stretch of the transcript, read back: a printed step block (its label,
 * verdict and measured duration, its lines unquoted), or the lines between
 * blocks (`output` — every line the build printed outside a step).
 */
export type TranscriptSegment =
  | {
      kind: "step";
      label: string;
      success: boolean;
      durationMs: number;
      lines: string[];
    }
  | { kind: "output"; lines: string[] };

/**
 * Cut a transcript into its segments, in order, dropping no line: a header
 * opens a step, its `│ ` lines are the step's, and the first unquoted line ends
 * it and opens an `output` segment. A header's own line is not one of the
 * step's lines (it is its label, verdict and duration).
 */
export function parseStepBlocks(lines: readonly string[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let current: TranscriptSegment | null = null;
  for (const line of lines) {
    const header = HEADER.exec(line);
    if (header !== null) {
      const [, label = "", icon, seconds = "0"] = header;
      current = {
        kind: "step",
        label,
        success: icon === PASSED,
        durationMs: Math.round(Number(seconds) * 1000),
        lines: [],
      };
      segments.push(current);
      continue;
    }
    if (current?.kind === "step" && line.startsWith(QUOTE)) {
      current.lines.push(line.slice(QUOTE.length));
      continue;
    }
    if (current?.kind !== "output") {
      current = { kind: "output", lines: [] };
      segments.push(current);
    }
    current.lines.push(line);
  }
  return segments;
}
