import { z } from "zod";
import { readChannelJson } from "@plugins/primitives/plugins/log-channels/plugins/log-files/server";
import { BOOT_JOURNAL_CHANNEL } from "@plugins/framework/plugins/server-core/core";

// The boot journal (server-core's `installBootJournal`, written by a serving
// backend as its boot accrues: every checkpoint, each load wave and each
// blocking hook as it opens, each slow span as it closes) read back — the one
// record of a boot the gateway SIGKILLed before ready, whose in-memory profile
// died with it.

const CheckpointSchema = z.object({ label: z.string(), atMs: z.number() });
const SpanSchema = z.object({
  id: z.string(),
  phase: z.string(),
  startMs: z.number(),
  durationMs: z.number(),
});
const EntrySchema = z.union([
  z.object({ e: z.literal("open"), id: z.string(), startMs: z.number() }),
  z.object({ e: z.literal("span"), span: SpanSchema }),
  z.object({ e: z.literal("checkpoint"), checkpoint: CheckpointSchema }),
]);
const JournalLineSchema = z.object({
  processStartedAt: z.number(),
  entry: EntrySchema,
});
type JournalLine = z.infer<typeof JournalLineSchema>;

// ~100 lines per boot (a line per checkpoint, wave open/close, blocking-hook
// open and slow span), so this covers a worktree's last ~20 boots — the
// attempts a watchdog tick or a timeline window asks about.
const MAX_LINES = 2000;

/** The steps a summary ranks: the import waves and the blocking hooks. */
const RANKED_PHASES = new Set(["load", "onReadyBlocking"]);
const SLOWEST_KEPT = 3;

/**
 * One boot's journal, summarised. All times are ms since its process started.
 * `diedIn` is the step still open at the journal's end (opened, never closed):
 * where a boot killed before ready was — null when every opened step closed.
 */
export interface BootJournalSummary {
  processStartedAt: number;
  /** When its last entry was written: how far the boot got, at least. */
  lastEntryAtMs: number;
  /** Plugin imports done (`after-import`), or null — it never finished importing. */
  importedAtMs: number | null;
  diedIn: { id: string; startMs: number } | null;
  /** The longest finished import waves and blocking hooks, longest first. */
  slowest: { id: string; ms: number }[];
  /**
   * How long it ran darwinbg: from start until the gateway's probe moved it
   * (`left-darwinbg`), or to its last entry if nothing did. Null when it did
   * not start darwinbg.
   */
  darwinbgMs: number | null;
}

/** Every boot in the worktree's journal, keyed by `processStartedAt`. */
export function readBootJournals(
  worktree: string,
): Map<number, BootJournalSummary> {
  const lines = readChannelJson(
    worktree,
    BOOT_JOURNAL_CHANNEL,
    MAX_LINES,
    JournalLineSchema,
  );
  return summariseBootJournals(lines);
}

/** The pure half of `readBootJournals` — co-located bun tests. */
export function summariseBootJournals(
  lines: readonly JournalLine[],
): Map<number, BootJournalSummary> {
  const byBoot = new Map<number, JournalLine["entry"][]>();
  for (const { processStartedAt, entry } of lines) {
    const list = byBoot.get(processStartedAt) ?? [];
    list.push(entry);
    byBoot.set(processStartedAt, list);
  }
  const out = new Map<number, BootJournalSummary>();
  for (const [processStartedAt, entries] of byBoot) {
    const open = new Map<string, number>();
    const finished: { id: string; ms: number }[] = [];
    const checkpoints = new Map<string, number>();
    let lastEntryAtMs = 0;
    for (const entry of entries) {
      if (entry.e === "open") {
        open.set(entry.id, entry.startMs);
        lastEntryAtMs = Math.max(lastEntryAtMs, entry.startMs);
      } else if (entry.e === "span") {
        const { span } = entry;
        open.delete(span.id);
        if (RANKED_PHASES.has(span.phase))
          finished.push({ id: span.id, ms: span.durationMs });
        lastEntryAtMs = Math.max(lastEntryAtMs, span.startMs + span.durationMs);
      } else {
        checkpoints.set(entry.checkpoint.label, entry.checkpoint.atMs);
        lastEntryAtMs = Math.max(lastEntryAtMs, entry.checkpoint.atMs);
      }
    }
    // The latest-opened step still open is the innermost one it was in.
    let diedIn: BootJournalSummary["diedIn"] = null;
    for (const [id, startMs] of open)
      if (diedIn === null || startMs >= diedIn.startMs)
        diedIn = { id, startMs };
    const startedDarwinbg = checkpoints.has("darwinbg-at-start");
    out.set(processStartedAt, {
      processStartedAt,
      lastEntryAtMs,
      importedAtMs: checkpoints.get("after-import") ?? null,
      diedIn,
      slowest: finished.sort((a, b) => b.ms - a.ms).slice(0, SLOWEST_KEPT),
      darwinbgMs: startedDarwinbg
        ? (checkpoints.get("left-darwinbg") ?? lastEntryAtMs)
        : null,
    });
  }
  return out;
}
