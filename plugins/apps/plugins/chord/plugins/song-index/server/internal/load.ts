import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { youtubeVideoId } from "@plugins/integrations/plugins/youtube/core";
import {
  SkipTally,
  alignmentFromSheetSage,
  compactChord,
  deriveSection,
  isInLoadScope,
  type LoadScope,
  type SkipSummary,
  type SnapshotSection,
} from "../../core";
import { readSnapshot, readSnapshotHeads } from "./snapshot";
import { _chordLoopWindows, _chordSections } from "./tables";

/** Sections per insert batch; the state row's progress moves once per batch. */
const SECTION_BATCH = 200;
/** Window rows per INSERT statement: 15 columns each, well under Postgres's 65,535 bind parameters. */
const WINDOW_INSERT_CHUNK = 2_000;

type SectionRow = typeof _chordSections.$inferInsert;
type WindowRow = typeof _chordLoopWindows.$inferInsert;

export type LoadResult = {
  sections: number;
  windows: number;
  skipped: SkipSummary;
};

/**
 * Replace the index's sections and windows with the snapshot's sections in
 * `scope`, derived at the current `INDEX_DERIVATION_VERSION`.
 *
 * **No transaction around the whole load.** A load writes ~26k sections and
 * ~184k windows; one transaction would hold them all uncommitted for minutes,
 * and the progress the app shows could not commit through it. Instead the
 * state row is the gate: the job sets it to a load phase before this runs, the
 * queries answer `not-ready` for any phase but `ready`, and only the job's last
 * write flips it back. So no reader ever sees a half-loaded index, and a load
 * that dies midway leaves a `failed` (or stuck `loading`) row that the next
 * `ensure` or boot replaces with a fresh load from the start — the tables are
 * truncated first, so a rerun never meets its predecessor's rows. Each batch
 * is its own transaction, so a section and its windows land together.
 */
export async function loadSections(args: {
  snapshotPath: string;
  scope: LoadScope;
  log: (line: string) => void;
  onProgress: (done: number, total: number) => Promise<void>;
}): Promise<LoadResult> {
  const inScope = (entry: {
    id: string;
    artistSlug: string | null;
    songSlug: string | null;
  }) => isInLoadScope(args.scope, entry);

  // The total the app counts down from, read off the lines' heads: four fields
  // per line, so the snapshot's chords are decoded once (by the pass below) and
  // not twice. `readSnapshotHeads` walks the same lines in the same order as
  // `readSnapshot`, so the count is exactly what the pass will step through.
  let total = 0;
  for (const head of readSnapshotHeads(args.snapshotPath)) {
    if (head.kind === "section" && inScope(head)) total++;
  }
  await args.onProgress(0, total);

  await db.execute(sql`TRUNCATE ${_chordLoopWindows}, ${_chordSections}`);

  const skips = new SkipTally();
  let done = 0;
  let sections = 0;
  let windows = 0;
  let sectionBatch: SectionRow[] = [];
  let windowBatch: WindowRow[] = [];

  const flush = async () => {
    if (sectionBatch.length > 0) {
      const rows = sectionBatch;
      const windowRows = windowBatch;
      await db.transaction(async (tx) => {
        await tx.insert(_chordSections).values(rows);
        for (let i = 0; i < windowRows.length; i += WINDOW_INSERT_CHUNK) {
          await tx
            .insert(_chordLoopWindows)
            .values(windowRows.slice(i, i + WINDOW_INSERT_CHUNK));
        }
      });
      sections += rows.length;
      windows += windowRows.length;
      sectionBatch = [];
      windowBatch = [];
    }
    await args.onProgress(done, total);
  };

  for (const line of readSnapshot(args.snapshotPath)) {
    if (!inScope(line)) continue;
    if (line.kind === "skipped") {
      skips.add(line.reason, line.id, line.detail);
      continue;
    }
    done++;
    const derived = deriveRows(line);
    if (derived.kind === "skipped") {
      skips.add(derived.reason, line.id, derived.detail);
    } else {
      sectionBatch.push(derived.section);
      windowBatch.push(...derived.windows);
    }
    if (done % SECTION_BATCH === 0) await flush();
  }
  await flush();

  args.log(
    `loaded ${sections} sections and ${windows} windows (${args.scope}); ${skips.total} skipped`,
  );
  return { sections, windows, skipped: skips.summary() };
}

/** One snapshot section as table rows, or the rule that leaves it out. */
export function deriveRows(
  line: SnapshotSection,
):
  | { kind: "rows"; section: SectionRow; windows: WindowRow[] }
  | { kind: "skipped"; reason: string; detail: string } {
  const videoId =
    line.youtube.id === null ? null : youtubeVideoId(line.youtube.id);
  const alignment = alignmentFromSheetSage(line.alignment);
  const derived = deriveSection({
    chords: line.chords,
    keys: line.keys,
    meters: line.meters,
    tempos: line.tempos,
    endBeat: line.endBeat,
    videoId,
    alignment,
  });
  if (derived.kind === "skipped") return derived;

  const section: SectionRow = {
    id: line.id,
    source: "sheetsage-dump",
    artist: line.artist,
    song: line.song,
    sectionName: line.sectionName,
    artistSlug: line.artistSlug,
    songSlug: line.songSlug,
    videoId,
    videoDurationSeconds: line.youtube.durationSeconds,
    alignment,
    keys: line.keys,
    meters: line.meters,
    tempos: line.tempos,
    endBeat: line.endBeat,
    chords: derived.chords.map(compactChord),
    unloopableReason:
      derived.loops.kind === "unloopable" ? derived.loops.reason : null,
    sourceTags: line.tags,
  };
  const windows: WindowRow[] =
    derived.loops.kind === "windows"
      ? derived.loops.windows.map((w) => ({ sectionId: line.id, ...w }))
      : [];
  return { kind: "rows", section, windows };
}
