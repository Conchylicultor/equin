/**
 * The text of the `backlog` tool's answer — written by the tool and read back
 * by the transcript viewer, from this one place so the two cannot drift. A
 * reader keeps a line it cannot read as text: transcripts written before a
 * change still show.
 */

/** One backlog task, as its line says it. */
export interface BacklogLine {
  taskId: string;
  /** `main` | `sidequest` (kept as written: a track added later still reads). */
  track: string;
  /** The task's status when it is not `new` (`held`, `blocked`); null for a
   *  task simply waiting. */
  status: string | null;
  title: string;
  /** The task whose agent filed it; null when a person filed or routed it. */
  filedFrom: string | null;
}

const EMPTY = "The backlog is empty.";

export function formatBacklogLine(line: BacklogLine): string {
  const held = line.status === null ? "" : ` [${line.status}]`;
  const from = line.filedFrom === null ? "" : ` (filed from ${line.filedFrom})`;
  return `- ${line.taskId} [${line.track}]${held} ${line.title}${from}`;
}

/** The whole answer: the header (with the cut, when `limit` lines were read),
 *  then one line per task — or the empty sentence. */
export function formatBacklog(
  lines: readonly BacklogLine[],
  limit: number,
): string {
  if (lines.length === 0) return EMPTY;
  const more =
    lines.length === limit
      ? ` — the oldest ${limit}; adopt, route or drop some to see the rest`
      : "";
  return `Backlog (${lines.length}${more}):\n${lines.map(formatBacklogLine).join("\n")}`;
}

export type ReadBacklogLine =
  ({ kind: "task" } & BacklogLine) | { kind: "text"; text: string };

export interface ReadBacklog {
  /** The task count its header states; 0 for the empty sentence, null when
   *  the text has neither (an error, a format this build does not know). */
  count: number | null;
  /** The header said the list was cut at the read limit. */
  truncated: boolean;
  lines: ReadBacklogLine[];
}

const HEADER = /^Backlog \((\d+)( — [^)]*)?\):$/;
const LINE =
  /^- (\S+) \[([^\]\s]+)\](?: \[([^\]\s]+)\])? (.+?)(?: \(filed from (\S+)\))?$/;

export function readBacklog(text: string): ReadBacklog {
  if (text.trim() === EMPTY) return { count: 0, truncated: false, lines: [] };
  const [first = "", ...rest] = text.split("\n");
  const header = HEADER.exec(first);
  const body = header ? rest : [first, ...rest];
  return {
    count: header ? Number(header[1]) : null,
    truncated: header?.[2] !== undefined,
    lines: body.filter((l) => l.trim() !== "").map(readBacklogLine),
  };
}

function readBacklogLine(line: string): ReadBacklogLine {
  const m = LINE.exec(line);
  if (!m) return { kind: "text", text: line.trim() };
  return {
    kind: "task",
    taskId: m[1]!,
    track: m[2]!,
    status: m[3] ?? null,
    title: m[4]!,
    filedFrom: m[5] ?? null,
  };
}
