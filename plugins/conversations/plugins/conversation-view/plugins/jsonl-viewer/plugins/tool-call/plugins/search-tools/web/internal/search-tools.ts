import { z } from "zod";

/**
 * Grep's and Glob's input, as their card reads it: the pattern, and the
 * filters (Glob has only `path`; the rest are Grep's).
 */
export const SearchInputSchema = z.looseObject({
  pattern: z.string(),
  path: z.string().optional(),
  glob: z.string().optional(),
  type: z.string().optional(),
  "-i": z.boolean().optional(),
  multiline: z.boolean().optional(),
  "-A": z.number().optional(),
  "-B": z.number().optional(),
  "-C": z.number().optional(),
  head_limit: z.number().optional(),
  output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
});

/**
 * The same input while the model writes it: any field may be missing yet, and
 * `output_mode` may stop mid-word (read as lines until it is a known mode).
 */
export const PartialSearchInputSchema = SearchInputSchema.partial().extend({
  output_mode: z.string().optional(),
});
export type PartialSearchInput = z.infer<typeof PartialSearchInputSchema>;

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

/** Reads a still-streaming input too: any field may be missing, and a string
 *  may be cut short. */
export function readSearchCall(
  name: string,
  input: PartialSearchInput,
): SearchCall {
  const tool = name === "Glob" ? "Glob" : "Grep";
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
      if (n !== undefined) filters.push(`${flag} ${n}`);
    }
    const head = input.head_limit;
    if (head !== undefined) filters.push(`head ${head}`);
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
