import { extname, sep } from "node:path";
import {
  defineCorpusIndex,
  type CorpusDelta,
} from "@plugins/infra/plugins/corpus-index/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import {
  setSourceMissing,
  listFolderImportedSongs,
} from "@plugins/apps/plugins/sonata/plugins/sources/plugins/midi/server";
import { sonataDir } from "@plugins/apps/plugins/sonata/data-dirs";
import { readableDirs, refreshFolderStatuses } from "./folder-status";
import { importMidiFileJob } from "./import-job";

const MIDI_EXTENSIONS = new Set([".mid", ".midi"]);

// The incremental, throttled, fingerprint-keyed enumeration of every `.mid`/
// `.midi` file under the watched folders. The generic mechanics (enumerate →
// (mtime,size) diff → drop-vanished → bounded, heavy-read-gated → atomic persist)
// live in `infra/corpus-index`; here there is no per-file payload, so `parse` is
// omitted (an enumerate-only `CorpusIndex<null>`). `ensureFresh()`'s delta is the
// whole point: `changedPaths` is exactly the set of files whose bytes moved since
// the last walk — which is how a file edited while the backend was down gets
// re-imported (a drift hole the old boot reconcile could never close).
//
// `scope: "host"` is deliberate: the corpus is a host-global user folder, so ONE
// shared index lives in the Sonata app's one data dir (`apps/sonata`, declared
// at the app root), and only main PERSISTS it. A per-worktree index would make
// every freshly-forked worktree start with an empty index, see every file as
// "changed", and enqueue an import job per MIDI file. The DB is still
// per-worktree, so `reconcile()` runs on every backend, reading the shared index
// and computing its own delta in memory.
const midiIndex = defineCorpusIndex({
  name: "sonata.midi-folders",
  description:
    "Remembers which MIDI files exist in the watched folders so changes can be detected quickly without rescanning.",
  // Only the readable folders: an unreadable one is shown in the library, never
  // walked — one bad root would otherwise abort the walk for every folder.
  roots: readableDirs,
  match: (p) => MIDI_EXTENSIONS.has(extname(p).toLowerCase()),
  indexPath: sonataDir.file("midi-folders-index.json"),
  scope: "host",
  version: 1,
});

/**
 * Injectable dependencies for {@link reconcileWith} — the testability seam,
 * mirroring corpus-index's own `RefreshDeps` style. Production wires these to the
 * real index + DB helpers; tests drive them with stubs so the decision logic
 * (which paths enqueue, the single `listFolderImportedSongs` call, reverse drift)
 * is verified without a filesystem or a database.
 */
export interface ReconcileDeps {
  markDirty: () => void;
  ensureFresh: () => Promise<CorpusDelta>;
  /** The authoritative on-disk set after the refresh (corpus `entries()`). */
  entries: () => Map<string, unknown>;
  watchedDirs: () => string[];
  listImported: () => Promise<
    { songId: string; sourcePath: string; sourceMissing: boolean }[]
  >;
  enqueueImport: (sourcePath: string) => Promise<void>;
  setSourceMissing: (songId: string, missing: boolean) => Promise<void>;
}

/**
 * Bring the DB in sync with disk across all watched folders (pure decision logic
 * over injected deps). Catches drift the live watcher cannot: changes while the
 * server was down, and pre-existing files in a newly added folder (the watcher
 * emits no events for those).
 *
 * - On-disk file with no song → enqueue import.
 * - On-disk file whose song is flagged missing (file came back) → enqueue
 *   re-import (refreshes bytes and clears the flag).
 * - On-disk file whose bytes changed while we were down (`modifiedPaths`) →
 *   enqueue re-import. `importMidiFileJob` dedups by `sourcePath` and
 *   `importMidiSong` reuses `existingSongId`, so a redundant enqueue is idempotent.
 * - Folder-imported song under a still-watched dir whose file is gone → mark
 *   missing. Songs under a no-longer-watched dir are left untouched.
 */
export async function reconcileWith(deps: ReconcileDeps): Promise<void> {
  // We own our own watcher (see CLAUDE.md — "own your own watcher"), so on the
  // main backend `ensureFresh()` would short-circuit on a clean `dirty` flag and
  // silently reuse a stale index. `markDirty()` is the ONLY invalidation seam.
  deps.markDirty();
  // ONLY `modifiedPaths` — never `addedPaths`. A path is "added" when the index
  // held no fingerprint for it, which on a cold index is EVERY file: this index
  // is `scope: "host"`, so a worktree backend never persists it and starts every
  // boot cold. Treating "added" as "changed" re-imported the entire corpus on
  // every worktree boot (19 files → 19 fresh attachments). The DB (`!song`)
  // is the authority on what is genuinely new; the fingerprint only proves EDITS.
  const { modifiedPaths } = await deps.ensureFresh();
  const modified = new Set(modifiedPaths);

  // ONE query for the whole folder-imported set (was one round-trip PER FILE).
  const songs = await deps.listImported();
  const byPath = new Map(songs.map((s) => [s.sourcePath, s]));

  // `entries()` after a refresh is the authoritative on-disk set — exactly the
  // old `onDisk` semantics. We use it (not `removedPaths`) for reverse drift on
  // purpose: `removedPaths` only covers files that vanished since the LAST
  // refresh, so a song whose file disappeared before this process ever built an
  // index would be missed by `removedPaths` alone; `entries()` reflects present
  // reality regardless of when the file went away.
  const onDisk = deps.entries();
  for (const path of onDisk.keys()) {
    const song = byPath.get(path);
    if (!song || song.sourceMissing || modified.has(path)) {
      await deps.enqueueImport(path);
    }
  }

  // Drift the other way: a folder-managed song whose file vanished. Only mark
  // missing when the song's source path is under a READABLE watched dir — a
  // folder removed from config leaves its songs untouched, and so does one that
  // cannot be read (its files are not known to be gone).
  const dirs = deps.watchedDirs();
  for (const song of songs) {
    if (song.sourceMissing) continue;
    if (onDisk.has(song.sourcePath)) continue;
    const stillWatched = dirs.some((dir) =>
      song.sourcePath.startsWith(dir.endsWith(sep) ? dir : dir + sep),
    );
    if (stillWatched) await deps.setSourceMissing(song.songId, true);
  }
}

/** Reconcile the DB against disk, wiring {@link reconcileWith} to the real index + DB. */
export async function reconcile(): Promise<void> {
  // Re-probe first: a folder that became readable (access granted, drive
  // plugged back in) is walked by this very reconcile, and one that stopped
  // being readable is left out of it.
  refreshFolderStatuses();
  await reconcileWith({
    markDirty: () => midiIndex.markDirty(),
    ensureFresh: () => midiIndex.ensureFresh(),
    entries: () => midiIndex.entries(),
    watchedDirs: readableDirs,
    listImported: listFolderImportedSongs,
    // `enqueue` resolves to the new `{ jobId }`; reconcile has no use for it
    // (the job is fire-and-forget, deduped by sourcePath), so await and discard.
    enqueueImport: async (sourcePath) => {
      await importMidiFileJob.enqueue({ sourcePath });
    },
    setSourceMissing,
  });
}

// Declared heavy boot warm-up (replacing the former `onReady`-reached recursive
// walk): DEFERRED past serving-ready and THROTTLED by the warmup executor instead
// of competing with first requests on `onReady`. `scope: "worktree"` because
// reconcile writes THIS backend's own DB (every backend reconciles its own fork).
// Warm-up throw-tolerance is correct: reconcile is drift repair, not a
// correctness dependency — the live watcher covers ongoing changes and the next
// `reconcile()` re-runs `ensureFresh()`.
export const midiFoldersWarmup = defineWarmup({
  name: "sonata.midi-folders.reconcile",
  description:
    "Catches up the Sonata library with MIDI files added, changed or removed in watched folders while the app was off.",
  scope: "worktree",
  run: reconcile,
});
