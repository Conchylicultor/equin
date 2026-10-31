import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import {
  importMidiSong,
  getSongMidiBySourcePath,
  setSourceMissing,
} from "@plugins/apps/plugins/sonata/plugins/sources/plugins/midi/server";

// The heavy import runs as a durable job so one corrupt `.mid` fails loudly in
// the graphile job log (and retries) without stalling the watcher. The watcher
// enqueues one of these per create/update event and per reconcile-detected new
// or restored file.
export const importMidiFileJob = defineJob({
  name: "sonata.midi.import",
  description:
    "Imports one MIDI file from a watched folder into the Sonata library.",
  // instant: a local file read, an in-memory MIDI parse and indexed writes —
  // no network, no spawn, no model call. "Heavy" above is relative to the
  // watcher callback it was moved off, not to a worker slot.
  hold: "instant",
  input: z.object({ sourcePath: z.string() }),
  event: z.never(),
  // Coalesce a burst of events for the same file (e.g. create+update) into one
  // pending import keyed by path. A later edit still re-runs once the prior job
  // clears, so the latest bytes always win.
  dedup: { key: (input) => input.sourcePath },
  async run({ input }) {
    const { sourcePath } = input;

    // Handle the create→delete race: the event fired but the file is already
    // gone by the time the job runs. Treat it as a deletion (badge the song if
    // we have one) and return — nothing to import, no crash.
    if (!(await Bun.file(sourcePath).exists())) {
      const existing = await getSongMidiBySourcePath(sourcePath);
      if (existing) await setSourceMissing(existing.songId, true);
      return;
    }

    // Fingerprint the file before reading it, so a failed import can tell a
    // file still being written (its bytes moved since) from a corrupt one.
    const before = await fingerprint(sourcePath);
    const bytes = await Bun.file(sourcePath).bytes();
    // A 0-byte file is not written yet, not a corrupt one: a writer creates the
    // file, then fills it, and the create event can land in between (on
    // 2026-10-31 `zz-probe.mid` failed two attempts as "Expected 'MHdr', got:
    // ''" before its bytes arrived). Nothing to import; the write that fills it
    // fires an update event, which enqueues this job again. A song whose file
    // was truncated keeps its last imported bytes until that write.
    if (bytes.length === 0) return;
    const existing = await getSongMidiBySourcePath(sourcePath);
    // `existingSongId` reuses the song row on re-import (edited file) and the
    // import clears `sourceMissing`.
    try {
      await importMidiSong({
        bytes,
        filename: basename(sourcePath),
        sourcePath,
        existingSongId: existing?.songId,
      });
    } catch (err) {
      // The bytes we read were mid-write (a writer that fills the file in
      // place rather than renaming a finished one over it): the file changed
      // since, so its write fired an update event that enqueued this job again
      // (the dedup key is released while we run), which imports the finished
      // bytes. Superseded, not failed. A file that did not change failed on its
      // own bytes — corrupt — and propagates, so the job retries loudly.
      if (!sameFingerprint(before, await fingerprint(sourcePath))) return;
      throw err;
    }
  },
});

/** The file's `(mtimeMs, size)`, or `null` once it is gone. */
async function fingerprint(
  path: string,
): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const { mtimeMs, size } = await stat(path);
    return { mtimeMs, size };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function sameFingerprint(
  a: { mtimeMs: number; size: number } | null,
  b: { mtimeMs: number; size: number } | null,
): boolean {
  return a?.mtimeMs === b?.mtimeMs && a?.size === b?.size;
}
