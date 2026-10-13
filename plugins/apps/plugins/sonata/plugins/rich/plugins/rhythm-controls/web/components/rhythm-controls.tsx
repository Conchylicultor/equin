import { useEffect, useMemo, useRef } from "react";
import {
  useCursorApi,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import {
  chordModeSetting,
  useLibrarySong,
  useSongSetting,
} from "@plugins/apps/plugins/sonata/plugins/document/web";
import { grooveCycles } from "@plugins/apps/plugins/sonata/plugins/voicing/core";
import {
  effectiveOnsets,
  toggleOnset,
} from "@plugins/apps/plugins/sonata/plugins/rhythm/core";
import {
  RhythmCircle,
  type RhythmCircleHandle,
  type RhythmCircleTrack,
} from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/rhythm-circle/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Switch } from "@plugins/primitives/plugins/css/plugins/switch/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { WithTooltip } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useGroove, type GrooveState } from "../use-groove";
import { GroovePresetPicker } from "./groove-preset-picker";
import { HandBlock } from "./hand-block";
import { HANDS, useHandTracks } from "./hands";

/**
 * The groove body, top to bottom: the groove preset picker, the rhythm circle
 * (one revolution per cycle with the playhead — per bar, and from each chord
 * change while the groove restarts on them — its beads clickable to toggle
 * onsets, each ring in its hand's track colour), the "Restart on chord change"
 * switch, and one expanded block per hand (on/off, pattern, rhythm, octave,
 * voice-leading, rotate, steps, octave doubling). The persisted groove feeds
 * the song document's score pipeline (via the rhythm observer), so
 * `reVoiceChords` plays the chords through it.
 *
 * Resolved groove + the optimistic commit come from the shared `useGroove()`
 * hook. While the song's groove is loading the body is a loading state — never
 * the default patterns standing in for the song's own. The composing section
 * owns the applicability gate (whether the song document voices this song's
 * chords at all).
 */
export function RhythmControls() {
  const song = useLibrarySong();
  const groove = useGroove();
  // Only a library song's groove persists: a file document shows no editor.
  if (song.kind === "none") return null;
  switch (groove.status) {
    case "loading":
      return <Loading variant="rows" count={3} />;
    case "error":
      return (
        <ResourceErrorInline
          variant="block"
          subject="this song's rhythm"
          error={groove.error}
          refetch={groove.refetch}
        />
      );
    case "ready":
      return <GrooveEditor groove={groove.data} />;
  }
}

/** The preset picker, circle and per-hand blocks over a KNOWN groove. */
function GrooveEditor({ groove }: { groove: GrooveState }) {
  const { score } = useSession();
  const handTracks = useHandTracks();
  const {
    presetId,
    bass,
    chord,
    bassFigurationId,
    chordFigurationId,
    bassVoicing,
    chordVoicing,
    restartOnChordChange,
    commit,
  } = groove;
  const chordMode = useSongSetting(chordModeSetting);
  const cursor = useCursorApi();
  const circleRef = useRef<RhythmCircleHandle>(null);

  // The groove's cycles — the very ones the engine strikes on (`grooveCycles`):
  // one per bar, split at each voiced chord's change while the groove restarts
  // on them. Chord mode decides which chords are voiced (authored only, or the
  // detected ones too).
  const include =
    chordMode.kind === "settled" && chordMode.value ? "all" : "authored";
  const cycles = useMemo(
    () => grooveCycles(score, { restartOnChordChange, include }),
    [score, restartOnChordChange, include],
  );

  // Drive the needle imperatively from the transport cursor — ZERO React renders
  // per frame (the exact `return cursor.subscribe(paint)` idiom the scrubber
  // uses). One revolution per cycle: phase = (beat − start) / span, so a cycle
  // restarted by a chord change starts the needle over from the top.
  useEffect(() => {
    return cursor.subscribe(() => {
      const handle = circleRef.current;
      if (!handle) return; // circle not mounted yet
      const beat = cursor.getBeat();
      // Last cycle whose start is <= beat.
      let lo = 0;
      let hi = cycles.length - 1;
      let idx = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if ((cycles[mid]?.start ?? 0) <= beat) {
          idx = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      const cycle = cycles[idx];
      if (!cycle) return; // no bars — leave the needle put
      const phase = Math.max(0, Math.min(1, (beat - cycle.start) / cycle.span));
      handle.setPhase(phase);
    });
  }, [cursor, cycles]);

  // The full groove payload with one field overridden — every commit carries
  // both hands' patterns, figuration ids, voicings AND the preset provenance,
  // so nothing is dropped.
  const fields = {
    presetId,
    bass,
    chord,
    bassFigurationId,
    chordFigurationId,
    bassVoicing,
    chordVoicing,
    restartOnChordChange,
  };

  // The hands wear their tracks' colours; until the mixer has the song's
  // tracks, the editor is not known yet.
  if (handTracks.kind === "pending") {
    return <Loading variant="rows" count={3} />;
  }
  if (handTracks.kind === "failed") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="this song's tracks"
        error={handTracks.error}
        refetch={handTracks.refetch}
      />
    );
  }
  const hands = handTracks.value;

  // An off hand keeps its ring (its beads still edit its rhythm), drawn in the
  // muted foreground so the circle reads which hands play.
  const tracks: RhythmCircleTrack[] = [
    {
      id: "chord",
      subdivisions: chord.subdivisions,
      onsets: effectiveOnsets(chord),
      colorVar: chordVoicing.enabled
        ? hands.chord.color
        : "var(--muted-foreground)",
      label: `${HANDS.chord.label} (${hands.chord.name})`,
    },
    {
      id: "bass",
      subdivisions: bass.subdivisions,
      onsets: effectiveOnsets(bass),
      colorVar: bassVoicing.enabled
        ? hands.bass.color
        : "var(--muted-foreground)",
      label: `${HANDS.bass.label} (${hands.bass.name})`,
    },
  ];

  const onToggleOnset = (trackId: string, index: number) => {
    if (trackId === "bass") {
      commit({ ...fields, bass: toggleOnset(bass, index) });
    } else {
      commit({ ...fields, chord: toggleOnset(chord, index) });
    }
  };

  return (
    <Stack gap="md">
      <GroovePresetPicker groove={groove} />
      <Center>
        <RhythmCircle
          ref={circleRef}
          tracks={tracks}
          onToggleOnset={onToggleOnset}
          size={180}
        />
      </Center>
      <Stack direction="row" gap="md" justify="between" align="center">
        <WithTooltip content="Start the rhythm over at every chord change, so a chord that changes mid-bar is played on its change. Off: the rhythm keeps its place in the bar.">
          <Text as="span" variant="body">
            Restart on chord change
          </Text>
        </WithTooltip>
        <Switch
          checked={restartOnChordChange}
          onCheckedChange={(on) =>
            commit({ ...fields, restartOnChordChange: on })
          }
          aria-label="Restart the rhythm on every chord change"
        />
      </Stack>
      <Stack gap="md">
        <HandBlock
          hand="chord"
          track={hands.chord}
          pattern={chord}
          onChange={(next) => commit({ ...fields, chord: next })}
          figurationId={chordFigurationId}
          onFigurationChange={(id) =>
            commit({ ...fields, chordFigurationId: id })
          }
          voicing={chordVoicing}
          onVoicingChange={(next) => commit({ ...fields, chordVoicing: next })}
        />
        <HandBlock
          hand="bass"
          track={hands.bass}
          pattern={bass}
          onChange={(next) => commit({ ...fields, bass: next })}
          figurationId={bassFigurationId}
          onFigurationChange={(id) =>
            commit({ ...fields, bassFigurationId: id })
          }
          voicing={bassVoicing}
          onVoicingChange={(next) => commit({ ...fields, bassVoicing: next })}
        />
      </Stack>
    </Stack>
  );
}
