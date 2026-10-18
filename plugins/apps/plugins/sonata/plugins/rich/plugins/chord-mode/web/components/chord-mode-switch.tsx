import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useState } from "react";
import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import {
  chordModeSetting,
  useLibrarySong,
  useSongSetting,
  useWriteSongSetting,
} from "@plugins/apps/plugins/sonata/plugins/document/web";
import {
  CHORD_BASS_TRACK,
  CHORD_TRACK,
} from "@plugins/apps/plugins/sonata/plugins/voicing/core";
import { setTracksActive } from "@plugins/apps/plugins/sonata/plugins/track-mixer/web";
import { Switch } from "@plugins/primitives/plugins/css/plugins/switch/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { WithTooltip } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useSaveChordMode } from "../actions";

const LABEL = "Accompaniment — play the song's chords";

/**
 * The chord-mode switch: the Accompaniment section's on/off for a song that
 * plays notes of its own (a MIDI song, a score, a transcription) and has
 * chords — detected or authored — in the section header, flipping the loaded
 * song's chord mode. A chord-only song (a chord grid, a chord sheet) always
 * plays its accompaniment and has no switch.
 *
 * One flip does two things, deliberately in an order that never doubles the
 * sound. The setting flips synchronously (the pipeline re-voices at once),
 * while the track-mixer write lands a live-state round-trip later:
 *  - **On:** turn the original tracks off FIRST (await the mixer write), then
 *    flip the mode so the chord tracks appear — a beat of silence, never both
 *    layers at once.
 *  - **Off:** flip the mode first (chord tracks vanish), then bring the original
 *    tracks back.
 * "Original tracks" are every score track that is not one of the two synthesized
 * chord tracks. Which of them plays in chord mode is then the Tracks card's
 * business: un-hide / un-mute any of them like any other track.
 *
 * While the song's mode is loading the switch is a loading placeholder: "off"
 * would be a claim about the song, and a flip needs a known base. A failed read
 * renders as an icon with its Retry. A file document has no chord mode to
 * flip, so the switch renders nothing.
 */
export function ChordModeSwitch() {
  const { score } = useSession();
  const song = useLibrarySong();
  const mode = useSongSetting(chordModeSetting);
  const setChordMode = useWriteSongSetting(chordModeSetting);
  const saveChordMode = useSaveChordMode();
  // Held while the awaited mixer write is in flight, so a second flip cannot
  // interleave the two directions.
  const [busy, setBusy] = useState(false);

  // Only a library song's chord mode persists; a file document has none to flip.
  if (song.kind === "none") return null;
  if (mode.kind === "failed")
    return (
      <ResourceErrorInline
        variant="icon"
        subject="the song's chord mode"
        error={mode.error}
        refetch={mode.refetch}
      />
    );
  const songId = song.songId;

  const originals = score.tracks
    .filter((t) => t.id !== CHORD_TRACK && t.id !== CHORD_BASS_TRACK)
    .map((t) => t.id);

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      if (next) {
        if (originals.length > 0) {
          await setTracksActive(songId, originals, false);
        }
        setChordMode(songId, true); // optimistic: the chord tracks appear at once
        saveChordMode(songId, true);
      } else {
        setChordMode(songId, false); // optimistic: the chord tracks vanish at once
        saveChordMode(songId, false);
        if (originals.length > 0) {
          await setTracksActive(songId, originals, true);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  if (mode.kind === "pending") return <Loading variant="spinner" />;
  return (
    <WithTooltip
      content={
        mode.value
          ? "Playing the song's chords on the Chords + Bass tracks. Turn off to play the song's own notes again."
          : "Play the song's chords (Chords + Bass tracks) and turn the original tracks off. Re-enable any track in the Tracks card."
      }
    >
      <Switch
        checked={mode.value}
        disabled={busy}
        onCheckedChange={(next) => void toggle(next)}
        aria-label={LABEL}
      />
    </WithTooltip>
  );
}
