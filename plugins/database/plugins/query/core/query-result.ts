import { z } from "zod";

// The answer `query_db` gives an agent, as one format + read pair shared by
// the server that writes it (server/internal/mcp-tools.ts) and the transcript
// renderer that reads it back (conversations/…/tool-call/query-db): a change to
// the shape is a type error in both, and the round trip is tested.

/** Rows an answer carries at most; the rest are counted in `rowCount`. */
export const QUERY_DB_MAX_ROWS = 200;

export const QueryDbResultSchema = z.object({
  /** The database the query ran against (the caller's own unless it named one). */
  database: z.string(),
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  /** The rows the statement produced, before the cap. */
  rowCount: z.number().nullable(),
  truncated: z.boolean(),
  /** A one-off remark for the agent (what the read aliases are). */
  note: z.string().optional(),
});

export type QueryDbResult = z.infer<typeof QueryDbResultSchema>;

export function formatQueryDbResult(result: QueryDbResult): string {
  return JSON.stringify(result);
}

export type QueryDbRead =
  { kind: "result"; result: QueryDbResult } | { kind: "unreadable" };

/** Reads an answer back; text that is not one (a failure message) is `unreadable`. */
export function readQueryDbResult(text: string): QueryDbRead {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return { kind: "unreadable" };
    throw err;
  }
  const parsed = QueryDbResultSchema.safeParse(json);
  return parsed.success
    ? { kind: "result", result: parsed.data }
    : { kind: "unreadable" };
}
