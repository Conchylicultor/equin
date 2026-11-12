import { z } from "zod";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import { defineSourceSet } from "@plugins/packages/plugins/source-digest/core";

// The pure half of reading the history: the `git log` format asked for and
// the parse of its output. Its code (this module's import closure) versions
// the stored history (`commit-log.ts`): a change here makes every process
// running it rebuild instead of extending a file another parse wrote.
export const parseLogCode = defineSourceSet(
  "stats/commits: the git log format and its parse, which shape every stored commit",
);
parseLogCode.include(import.meta);

/** One commit as every series reads it: when, and which push / conversation. */
export interface CommitHeader {
  sha: string;
  iso: string;
  pushId: string | null;
  conversationId: string | null;
}

/** A commit with its line stats (`git log --numstat`). */
export interface CommitInfo extends CommitHeader {
  added: number;
  removed: number;
  byExt: Record<string, { added: number; removed: number }>;
}

export const CommitInfoSchema = z.object({
  sha: z.string(),
  iso: z.string(),
  pushId: z.string().nullable(),
  conversationId: z.string().nullable(),
  added: z.number(),
  removed: z.number(),
  byExt: z.record(
    z.string(),
    z.object({ added: z.number(), removed: z.number() }),
  ),
}) satisfies z.ZodType<CommitInfo>;

/** The `--format` every read asks for: `parseLog` reads exactly it. */
export const LOG_FORMAT = `--format=__C__%H\x1f%cI\x1f%(trailers:key=${LEGACY_IDS.pushTrailer},valueonly)\x1f%(trailers:key=${LEGACY_IDS.conversationTrailer},valueonly)`;

interface ParsedChunk {
  header: CommitHeader;
  /** The numstat lines after the header (empty without `--numstat`). */
  statLines: string[];
}

function parseChunks(text: string): ParsedChunk[] {
  // Split on __C__ markers — each chunk is one commit's header + numstat.
  // Trailer values append newlines, so the \x1f-delimited header may span
  // multiple lines; splitting on __C__ captures the full record.
  return text
    .split("__C__")
    .filter(Boolean)
    .map((chunk) => {
      const fields = chunk.split("\x1f");
      const restLines = (fields[3] ?? "").split("\n");
      return {
        header: {
          sha: (fields[0] ?? "").trim(),
          iso: (fields[1] ?? "").trim(),
          pushId: (fields[2] ?? "").trim() || null,
          conversationId: (restLines[0] ?? "").trim() || null,
        },
        statLines: restLines.slice(1),
      };
    });
}

/** The commits of a `git log LOG_FORMAT` (no `--numstat`), in output order. */
export function parseHeaders(text: string): CommitHeader[] {
  return parseChunks(text).map((c) => c.header);
}

/** The commits of a `git log LOG_FORMAT --numstat`, in output order. */
export function parseNumstatLog(text: string): CommitInfo[] {
  return parseChunks(text).map(({ header, statLines }) => {
    const current: CommitInfo = {
      ...header,
      added: 0,
      removed: 0,
      byExt: {},
    };
    for (const line of statLines) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length >= 3) {
        const ins = parts[0]! === "-" ? 0 : parseInt(parts[0]!, 10) || 0;
        const del = parts[1]! === "-" ? 0 : parseInt(parts[1]!, 10) || 0;
        current.added += ins;
        current.removed += del;
        const filepath = parts[2]!;
        const dotIdx = filepath.lastIndexOf(".");
        const ext =
          dotIdx >= 0 ? filepath.slice(dotIdx).toLowerCase() : "(none)";
        const e = current.byExt[ext] ?? { added: 0, removed: 0 };
        e.added += ins;
        e.removed += del;
        current.byExt[ext] = e;
      }
    }
    return current;
  });
}
