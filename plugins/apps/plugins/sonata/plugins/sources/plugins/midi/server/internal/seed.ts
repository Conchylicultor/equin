import { Midi } from "@tonejs/midi";
import { like, inArray } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { createAttachment } from "@plugins/infra/plugins/attachments/server";
import {
  _songs,
  createSongRow,
  songAttachments,
  updateSongMeta,
} from "@plugins/apps/plugins/sonata/plugins/library/server";
import { songIdKind } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { MIDI_SOURCE_ID } from "../../shared/constants";
import { songMidi } from "./tables";
import { hashMidiBytes } from "./import";
import { deriveMidiSongMeta } from "../../shared/parse";
import {
  STARTERS,
  type FileStarter,
  type NotesStarter,
  type Starter,
} from "./starters";

/** Id prefix for songs this seeder owns. Only this seeder mints `seed-*` ids. */
const SEED_ID_PREFIX = "seed-";

/** A starter's MIDI bytes and what the library row needs of them. */
interface StarterMidi {
  bytes: Uint8Array;
  trackCount: number;
  durationSec: number;
  endBeat: number;
}

/** Decode base64 text to bytes (`atob` exists on every host: Bun and a worker). */
function base64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Build a notes starter's MIDI: one MIDI track per `StarterTrack` (its own
 * piano-roll color + audio route), the starter's time signature in the header
 * so the notation lens bars it correctly, sustain as CC64.
 */
function notesStarterMidi(starter: NotesStarter): StarterMidi {
  const midi = new Midi();
  // Self-describing title (also folds the title into the content hash, so a
  // title-only edit re-mints on the next boot).
  midi.header.name = starter.title;
  // Set tempo BEFORE adding notes: `addNote` converts our absolute-seconds
  // times to ticks through the header tempo, so it must be the final bpm.
  midi.header.setTempo(starter.bpm);
  if (starter.timeSig) {
    const [numerator, denominator] = starter.timeSig;
    midi.header.timeSignatures.push({
      ticks: 0,
      timeSignature: [numerator, denominator],
    });
    midi.header.update();
  }

  for (const trackDef of starter.tracks) {
    const track = midi.addTrack();
    if (trackDef.name != null) track.name = trackDef.name;
    if (trackDef.program != null) track.instrument.number = trackDef.program;
    for (const note of trackDef.notes) {
      track.addNote({
        midi: note.midi,
        time: note.time,
        duration: note.duration,
        // @tonejs/midi velocity is normalised 0–1; our StarterNote is 0–127.
        ...(note.velocity != null ? { velocity: note.velocity / 127 } : {}),
      });
    }
    // Sustain pedal (CC64): a down (127) / up (0) pair per span, so the
    // pedaling round-trips through the SAME importer path as a real file's.
    for (const span of trackDef.pedal ?? []) {
      track.addCC({ number: 64, value: 1, time: span.down });
      track.addCC({ number: 64, value: 0, time: span.up });
    }
  }

  // Score length spans every track's notes.
  const durationSec = Math.max(
    ...starter.tracks.flatMap((t) => t.notes.map((n) => n.time + n.duration)),
  );
  return {
    bytes: midi.toArray(),
    trackCount: midi.tracks.length,
    durationSec,
    // Quarter-note beats: seconds × (bpm / 60).
    endBeat: (durationSec * starter.bpm) / 60,
  };
}

/** A file starter's MIDI: its bytes as shipped, measured as any import is. */
function fileStarterMidi(starter: FileStarter): StarterMidi {
  const bytes = base64Bytes(starter.base64);
  const meta = deriveMidiSongMeta(bytes, `${starter.id}.mid`);
  return {
    bytes,
    trackCount: meta.trackCount,
    durationSec: meta.durationSec,
    endBeat: meta.endBeat,
  };
}

function starterMidi(starter: Starter): StarterMidi {
  switch (starter.kind) {
    case "notes":
      return notesStarterMidi(starter);
    case "file":
      return fileStarterMidi(starter);
  }
}

/**
 * Idempotently materialize the bundled MIDI starters at boot. Owned by the
 * MIDI source (not the library) since starters are inherently source-specific —
 * a future source seeds its own.
 *
 * Idempotency is **content-keyed**: each starter's MIDI is rebuilt (or decoded)
 * and hashed, and we skip only when the stored `contentHash` already matches.
 * That makes a starter's definition the source of truth — editing a starter
 * re-mints its seed on the next boot instead of silently keeping the stale MIDI.
 * `createSongRow`'s `onConflictDoNothing` preserves the existing song row.
 */
export async function seedMidiStarters(): Promise<void> {
  for (const starter of STARTERS) {
    const { bytes, trackCount, durationSec, endBeat } = starterMidi(starter);
    const contentHash = hashMidiBytes(bytes);

    // Up to date already → nothing to do. A drift (new/edited starter, or the
    // legacy ext-less row) falls through and (re-)mints the attachment + ext.
    const existing = await songMidi.get(starter.id);
    if (existing?.contentHash === contentHash) continue;

    const att = await createAttachment(
      bytes,
      `${starter.id}.mid`,
      "audio/midi",
    );
    // `createSongRow` inserts only when absent (onConflictDoNothing), so for a
    // starter whose id already exists but whose definition changed the row
    // metadata would go stale: sync it after ensuring the row exists.
    // A starter's id is a fixed natural key in the song kind's `seed` alias
    // namespace (`seed-bach-prelude-c-major`) — no shape the kind mints or
    // parses — so it is branded as is.
    const songId = songIdKind.key(starter.id);
    const meta = {
      title: starter.title,
      composer: starter.composer,
      durationSec,
      endBeat,
    };
    await createSongRow({ id: songId, ...meta, source: MIDI_SOURCE_ID });
    await updateSongMeta({ id: songId, ...meta });
    await songMidi.upsert(starter.id, {
      attachmentId: att.id,
      trackCount,
      contentHash,
    });
    // `.set`: a re-minted starter drops its previous attachment.
    await songAttachments.set(starter.id, [att.id]);
  }
}

/**
 * Make `STARTERS` authoritative: delete managed seed songs whose id is no longer
 * in `STARTERS`, so removing or renaming a starter propagates on the next boot
 * instead of leaving an orphaned row behind. Managed = the `seed-` id prefix,
 * which only this seeder ever mints.
 *
 * Deletes the `sonata_songs` row directly (as the library's own delete handler
 * does); FK CASCADE reclaims the per-source ext row and the song↔attachment link,
 * and the now-unreferenced attachment file is swept by the hourly orphan sweep.
 *
 * Reconcile removed ids only (diff against the static `STARTERS` list), so the
 * order relative to `seedMidiStarters()` is immaterial.
 */
export async function reconcileSeededStarters(): Promise<void> {
  const rows = await db
    .select({ id: _songs.id })
    .from(_songs)
    .where(like(_songs.id, `${SEED_ID_PREFIX}%`));

  const wanted = new Set<string>(STARTERS.map((s) => s.id));
  const stale = rows.map((r) => r.id).filter((id) => !wanted.has(id));
  if (stale.length === 0) return;

  await db.delete(_songs).where(inArray(_songs.id, stale));
}
