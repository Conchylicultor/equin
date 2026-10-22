import { z } from "zod";
import { statIfPresent, type WorkflowRunDir } from "./discovery";

/**
 * A workflow run's `journal.jsonl` is to its agents what the parent's
 * `tool_result` is to a foreground `Agent` call: the line saying an agent is DONE.
 *
 * ```
 * {"type":"launched"}
 * {"type":"started","key":"v2:…","agentId":"a74d…","label":"substrate","phase":"Substrate"}
 * {"type":"result","key":"v2:…","agentId":"a74d…","result":{…the agent's structured output…}}
 * ```
 *
 * Only `result` lines matter here, and of them only the `agentId`. Every other
 * type is ignored rather than rejected: the journal's vocabulary is the
 * harness's to grow, and a new line type says nothing about who has reported.
 */
const JournalLineSchema = z.object({ type: z.string() });
const ResultLineSchema = z.object({
  type: z.literal("result"),
  agentId: z.string(),
});

/** What we remember about one journal between scans. */
interface JournalState {
  /** Byte offset just past the last COMPLETE line already read. */
  offset: number;
  mtimeMs: number;
  reported: Set<string>;
}

/**
 * Per-scope, per-journal read state — why a new `result` line costs a read of
 * that line and nothing else.
 *
 * The journal only ever grows, and it is not small: each `result` embeds the
 * agent's whole structured output, so one real run's journal is ~370 KB. It is
 * also re-read on every change to ANY sub-agent in the conversation, since the
 * activity scan is one pass. So the read is incremental: `[offset, size)` only,
 * and only when the stat moved. Dropped with the rest of the scan state when
 * nothing is subscribed (`evictActivityScan`).
 */
const journals = new Map<string, Map<string, JournalState>>();

export function evictWorkflowJournals(scope: string): void {
  journals.delete(scope);
}

const NEWLINE = 0x0a;
const decoder = new TextDecoder();

/**
 * Fold one chunk of complete lines into `reported`.
 *
 * A line that cannot be understood is skipped ON ITS OWN, and said out loud:
 * one torn or foreign line must never cost the whole run its completion
 * signal, and it must never cost the conversation its activity list. Only the
 * two failures that mean "this LINE makes no sense" are absorbed — malformed
 * JSON and a shape the schema rejects; anything else throws.
 */
function foldLines(
  journalPath: string,
  text: string,
  reported: Set<string>,
): void {
  for (const raw of text.split("\n")) {
    if (raw === "") continue;
    try {
      const value: unknown = JSON.parse(raw);
      // Two passes over the RAW value: the first object schema strips the keys
      // it does not name, so the result schema must not be fed its output.
      if (JournalLineSchema.parse(value).type !== "result") continue;
      reported.add(ResultLineSchema.parse(value).agentId);
    } catch (err) {
      if (err instanceof SyntaxError || err instanceof z.ZodError) {
        console.warn(
          `[subagents] skipped an unreadable workflow journal line in ${journalPath}: ${
            err instanceof SyntaxError
              ? "not valid JSON"
              : err.issues[0]?.message
          }`,
        );
        continue;
      }
      throw err;
    }
  }
}

/**
 * The agents a journal records a `result` for, read incrementally.
 *
 * Only COMPLETE lines are read: the harness may be mid-append, so the offset
 * advances to just past the last newline in the new bytes, and a trailing
 * partial line is read again — whole — next time. Offsets are in BYTES, and
 * the cut is made on the raw bytes before decoding, so a multi-byte character
 * straddling the read boundary is never split.
 *
 * A journal that SHRANK (or whose mtime went backwards) is not the file we
 * were reading — it was rewritten — so its state starts over from byte 0. A
 * journal that does not exist yet has no reports, which is the ordinary state
 * of a run whose folder was just created.
 */
export async function readReportedAgents(
  scope: string,
  journalPath: string,
): Promise<ReadonlySet<string>> {
  let byPath = journals.get(scope);
  if (!byPath) {
    byPath = new Map();
    journals.set(scope, byPath);
  }

  const st = await statIfPresent(journalPath);
  if (st === null) {
    byPath.delete(journalPath);
    return new Set();
  }

  let state = byPath.get(journalPath);
  if (!state || st.size < state.offset || st.mtimeMs < state.mtimeMs) {
    state = { offset: 0, mtimeMs: st.mtimeMs, reported: new Set() };
    byPath.set(journalPath, state);
  }
  state.mtimeMs = st.mtimeMs;
  if (st.size === state.offset) return state.reported;

  const bytes = new Uint8Array(
    await Bun.file(journalPath).slice(state.offset, st.size).arrayBuffer(),
  );
  const lastNewline = bytes.lastIndexOf(NEWLINE);
  if (lastNewline < 0) return state.reported;

  foldLines(
    journalPath,
    decoder.decode(bytes.subarray(0, lastNewline)),
    state.reported,
  );
  state.offset += lastNewline + 1;
  return state.reported;
}

/**
 * Every run's reported agents, keyed by run id — and the scope's state for
 * journals no longer listed dropped, so a run folder that disappears does not
 * pin its read state forever.
 */
export async function readWorkflowReports(
  scope: string,
  runs: readonly WorkflowRunDir[],
): Promise<Map<string, ReadonlySet<string>>> {
  const byRun = new Map<string, ReadonlySet<string>>();
  for (const run of runs) {
    byRun.set(run.runId, await readReportedAgents(scope, run.journalPath));
  }
  const byPath = journals.get(scope);
  if (byPath) {
    const live = new Set(runs.map((r) => r.journalPath));
    for (const path of [...byPath.keys()]) {
      if (!live.has(path)) byPath.delete(path);
    }
  }
  return byRun;
}
