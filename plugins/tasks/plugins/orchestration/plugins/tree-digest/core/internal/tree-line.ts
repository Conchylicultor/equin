/**
 * The text of a tree line — what `task_tree` and the digest `add_task`
 * appends say about each task — written by the digest and read back by the
 * transcript viewer, from this one place so the two cannot drift. A reader
 * keeps a line it cannot read as text: transcripts written before a change
 * still show.
 */

/** One task of the tree, as its line says it. */
export interface TreeLine {
  /** Levels below the tree's top. */
  depth: number;
  taskId: string;
  title: string;
  /** The task's status, then every annotation (track, armed / manual,
   *  report…), in line order. */
  words: readonly string[];
  /** The reading agent's own task. */
  self: boolean;
}

const SELF_WORD = "your task";
const INDENT = "  ";

export function formatTreeLine(line: TreeLine): string {
  const words = line.self ? [...line.words, SELF_WORD] : line.words;
  return `${INDENT.repeat(line.depth)}- ${line.taskId} ${JSON.stringify(line.title)} — ${words.join(", ")}`;
}

/** The first line of a whole tree. */
export function formatTreeHeader(rootTaskId: string): string {
  return `Your task tree (root ${rootTaskId}):`;
}

export type ReadTreeLine =
  ({ kind: "task" } & TreeLine) | { kind: "text"; text: string };

export interface ReadTree {
  /** Null when the text has no whole-tree header (a delta, a notice). */
  rootTaskId: string | null;
  lines: ReadTreeLine[];
}

const HEADER = /^Your task tree \(root (\S+)\):$/;
const LINE = /^((?: {2})*)- (\S+) ("(?:[^"\\]|\\.)*") — (.*)$/;

export function readTree(text: string): ReadTree {
  const [first = "", ...rest] = text.split("\n");
  const header = HEADER.exec(first);
  const body = header ? rest : [first, ...rest];
  return {
    rootTaskId: header ? header[1]! : null,
    lines: body.filter((l) => l.trim() !== "").map(readTreeLine),
  };
}

function readTreeLine(line: string): ReadTreeLine {
  const m = LINE.exec(line);
  const title = m ? parseQuoted(m[3]!) : null;
  if (!m || title === null) return { kind: "text", text: line.trim() };
  const words = m[4]!.split(", ");
  return {
    kind: "task",
    depth: m[1]!.length / INDENT.length,
    taskId: m[2]!,
    title,
    words: words.filter((w) => w !== SELF_WORD),
    self: words.includes(SELF_WORD),
  };
}

function parseQuoted(quoted: string): string | null {
  try {
    const value: unknown = JSON.parse(quoted);
    return typeof value === "string" ? value : null;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
}
