import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

// The two reads of Debug → Logs, served in `server/internal/` and read with
// `useLive` in `web/components/`. Both are external (the truth is files on
// disk) and pushed by a watch of the folders holding them, so nothing polls.

/**
 * Where a log lives, which decides who declared it:
 * - `worktree` — a `defineLogSink` channel, one file per worktree;
 * - `backend` — the backend process's own stdout / stderr, captured by the
 *   gateway that launched it (rotated by the gateway, not by a sink);
 * - `host` — a `defineFileSink` shared by every worktree (the op log, …);
 * - `undeclared` — a file in the worktree's logs folder no sink declares: a
 *   browser `clientLog` channel (the one open-ended family), or a writer that
 *   bypassed `defineLogSink`.
 */
export const LOG_SCOPES = [
  "worktree",
  "backend",
  "host",
  "undeclared",
] as const;
export const LogScopeSchema = z.enum(LOG_SCOPES);
export type LogScope = z.infer<typeof LogScopeSchema>;

/** One file of a log's kept history: generation 0 is the live file, N is `<file>.N`. */
const LogFileSchema = z.object({
  generation: z.number().int(),
  bytes: z.number(),
  bornMs: z.number(),
  modifiedMs: z.number(),
});
export type LogFile = z.infer<typeof LogFileSchema>;

export const LogEntrySchema = z.object({
  /** What the reader opens it by: the sink id, `backend`, or the file's name. */
  id: z.string(),
  scope: LogScopeSchema,
  /** What the log records, as its declaration says; `null` for an undeclared file. */
  description: z.string().nullable(),
  /** The live file's absolute path. */
  path: z.string(),
  /** The rotation bound that keeps it finite; `null` when no sink bounds it here. */
  bound: z.object({ maxBytes: z.number(), keep: z.number() }).nullable(),
  /** Its kept files, newest first; none = declared but never written. */
  files: z.array(LogFileSchema),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

/**
 * Every log of one worktree (plus the host-wide ones), with each file's size
 * and age. Bounded by the files in a handful of folders.
 */
export const logsCatalog = liveValue("debug.logs.catalog", {
  schema: z.object({ entries: z.array(LogEntrySchema) }),
  params: ["worktree"],
  refusals: ["invalid-worktree"],
});

export const LogLineSchema = z.object({
  /** The line's place in the log's whole kept history — stable across a rotation. */
  position: z.string(),
  /** Which file holds it now (0 = live). */
  generation: z.number().int(),
  /** When it was written, when the line says (a log-channel envelope, a gateway prefix). */
  t: z.number().nullable(),
  stream: z.enum(["stdout", "stderr"]).nullable(),
  text: z.string(),
});
export type LogLine = z.infer<typeof LogLineSchema>;

export const LogLinesQuerySchema = z.object({
  worktree: z.string(),
  log: z.string(),
  /** Read back from this instant (ms) instead of from the newest line; `null` = newest. */
  at: z.number().nullable(),
});
export type LogLinesQuery = z.infer<typeof LogLinesQuerySchema>;

/** Lines per page, and the most one read without a viewport holds. */
const LINES_PAGE = 200;
const LINES_MAX = 2000;

const LOG_LINES_REFUSALS = [
  "invalid-worktree",
  "unknown-log",
  "invalid-cut",
] as const;
/** Why a lines read was refused: a malformed worktree, a log it does not have, a forged cut. */
export type LogLinesRefusal = (typeof LOG_LINES_REFUSALS)[number];

/**
 * One log's lines, newest first, across its whole kept history — the live file
 * and every rotation — paged by position, so scrolling back crosses a rotation
 * instead of ending at the live file's first line.
 */
export const logLines = liveValue("debug.logs.lines", {
  query: LogLinesQuerySchema,
  paged: {
    item: LogLineSchema,
    id: "position",
    key: { of: (line) => [line.position], order: ["desc"] },
    limit: LINES_PAGE,
    maxLimit: LINES_MAX,
  },
  refusals: LOG_LINES_REFUSALS,
});
