import {
  chordModeSetting,
  defaultGroove,
  useHasVoicedChords,
  useSongDocument,
  useSongSetting,
} from "@plugins/apps/plugins/sonata/plugins/document/web";
import {
  Library,
  type SongLinkValue,
} from "@plugins/apps/plugins/sonata/plugins/library/web";
import { grooveEquals, type GrooveContent } from "../shared/groove";
import { decodeGrooveLink, encodeGrooveLink } from "../shared/groove-link";
import { setRhythmEndpoint } from "../shared/endpoints";
import { useGroove } from "./use-groove";

/** What the default accompaniment sounds like — a song with no groove row. */
function defaultContent(): GrooveContent {
  const d = defaultGroove();
  return {
    bass: d.hands.bass,
    chord: d.hands.chord,
    bassFigurationId: d.bassFigurationId,
    chordFigurationId: d.chordFigurationId,
    bassVoicing: d.bassVoicing,
    chordVoicing: d.chordVoicing,
    restartOnChordChange: d.restartOnChordChange,
  };
}

/**
 * The open song's groove as its link spells it (`;groove=`) — only while the
 * song plays it: none while its chords are not voiced (a MIDI song with the
 * accompaniment off), and none while it sounds like the default accompaniment,
 * which a song created from the link plays anyway. Not known while the song,
 * its chord mode or its groove is still loading (or a read failed).
 */
function useGrooveLinkValue(): SongLinkValue {
  const groove = useGroove();
  const voiced = useHasVoicedChords();
  const contentReady = useSongDocument().content.kind === "ready";
  const chordMode = useSongSetting(chordModeSetting);
  if (!contentReady || chordMode.kind !== "settled") return { known: false };
  if (!voiced) return { known: true, value: null };
  if (groove.status !== "ready") return { known: false };
  const g = groove.data;
  return {
    known: true,
    value: grooveEquals(g, defaultContent()) ? null : encodeGrooveLink(g),
  };
}

/**
 * The groove's part of a song's link: the accompaniment, and — on a song just
 * created from a link — that link's accompaniment written as the song's. A
 * value that is not a groove is skipped (the song keeps the default), like a
 * malformed `;bar`.
 */
export const grooveSongLink = Library.SongLink({
  key: "groove",
  useValue: useGrooveLinkValue,
  apply: async ({ fetchEndpoint }, { id, value }) => {
    const decoded = decodeGrooveLink(value);
    if (!decoded.ok) return;
    const g = decoded.groove;
    await fetchEndpoint(
      setRhythmEndpoint,
      { id },
      {
        body: {
          bass: { ...g.bass, onsets: [...g.bass.onsets] },
          chord: { ...g.chord, onsets: [...g.chord.onsets] },
          bassPatternId: g.bassFigurationId,
          chordPatternId: g.chordFigurationId,
          bassVoicing: g.bassVoicing,
          chordVoicing: g.chordVoicing,
          groovePresetId: g.presetId,
          restartOnChordChange: g.restartOnChordChange,
        },
      },
    );
  },
});
