import type { ToolCallEvent } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";

/** What the result lists: paths (Glob, Grep files_with_matches), matching
 *  lines (Grep content), or per-file counts (Grep count). */
export type SearchShape = "files" | "lines" | "counts";

export interface SearchCall {
  tool: "Grep" | "Glob";
  pattern: string;
  /** Compact filters in the order they read: path, glob, type, flags. */
  filters: string[];
  shape: SearchShape;
}

export interface SearchOutcome {
  /** Files for `files`, matching lines for `lines`, matches for `counts`. */
  count: number;
  /** The unit `count` counts, singular. */
  unit: "file" | "line" | "match";
  /** The result's body lines (header and trailer stripped). */
  lines: string[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Tolerates a still-streaming input: any field may be missing or the wrong
 *  type, and a string may be cut short. */
export function readSearchCall(event: ToolCallEvent): SearchCall {
  const input = (event.input ?? {}) as Record<string, unknown>;
  const tool = event.name === "Glob" ? "Glob" : "Grep";
  const filters: string[] = [];
  const path = str(input.path);
  if (path) filters.push(`in ${path}`);
  if (tool === "Grep") {
    const glob = str(input.glob);
    if (glob) filters.push(`glob ${glob}`);
    const type = str(input.type);
    if (type) filters.push(`type ${type}`);
    if (input["-i"] === true) filters.push("-i");
    if (input.multiline === true) filters.push("multiline");
    for (const flag of ["-A", "-B", "-C"] as const) {
      const n = input[flag];
      if (typeof n === "number") filters.push(`${flag} ${n}`);
    }
    const head = input.head_limit;
    if (typeof head === "number") filters.push(`head ${head}`);
  }
  const mode = input.output_mode;
  const shape: SearchShape =
    tool === "Glob" || mode === undefined || mode === "files_with_matches"
      ? "files"
      : mode === "count"
        ? "counts"
        : "lines";
  return { tool, pattern: str(input.pattern) ?? "", filters, shape };
}

const HEADER = /^Found \d+ (files?|lines?)\s*$/;
const TOTALS = /^Found (\d+) total occurrences? across \d+ files?\.?$/;
const NO_MATCH = /^No (files|matches) found/;
const PAGINATION = /^\[Showing results with pagination/;

/** Parse a successful result; the harness's own summary lines are dropped, so
 *  what remains is exactly the listing. */
export function parseSearchResult(
  shape: SearchShape,
  content: string,
): SearchOutcome {
  const lines = content
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(
      (l) =>
        l !== "" && !HEADER.test(l) && !NO_MATCH.test(l) && !PAGINATION.test(l),
    );
  if (shape === "files") {
    return { count: lines.length, unit: "file", lines };
  }
  if (shape === "lines") {
    const matching = lines.filter((l) => l !== "--");
    return { count: matching.length, unit: "line", lines };
  }
  const totals = lines.map((l) => TOTALS.exec(l)).find((m) => m !== null);
  const body = lines.filter((l) => !TOTALS.test(l));
  const sum = body.reduce((acc, l) => {
    const n = Number(l.slice(l.lastIndexOf(":") + 1));
    return acc + (Number.isFinite(n) ? n : 0);
  }, 0);
  return {
    count: totals ? Number(totals[1]) : sum,
    unit: "match",
    lines: body,
  };
}

export function plural(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`;
}
