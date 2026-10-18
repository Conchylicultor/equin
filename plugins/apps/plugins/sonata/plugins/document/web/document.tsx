import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  applySwingOverride,
  emptyScore,
  mergeAnnotations,
  mergeScores,
  spellScore,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  inferKeys,
  transposeScore,
} from "@plugins/apps/plugins/sonata/plugins/theory/core";
import {
  hasOwnNotes,
  reVoiceChords,
} from "@plugins/apps/plugins/sonata/plugins/voicing/core";
import { SonataDocument } from "./slots";
import type { SongIdentity } from "./identity";
import {
  LoadedSongProvider,
  useEditLoadedRaw,
  useLoadedDocument,
  useLoadedRaw,
} from "./loaded-song";
import { useScoreSettings } from "./score-settings";
import type { SongSettingFailure } from "./song-setting";

/**
 * A song document's composed content. Every arm carries `contentKey`: the
 * identity of the loaded TIMELINE (the compiled, merged sources, before any
 * view transform) — it moves only when real content is loaded or edited, so a
 * playback session keyed on it resets for a new song but never for a
 * transpose / voicing / key change over the same one.
 *
 *  - `empty`: no source has input — an empty score is simply the truth.
 *  - `pending`: content is loaded but a per-song setting the composition
 *    registers has not settled for it yet. Nothing renders or plays the song
 *    under a default or under another song's settings — a display shows a
 *    loading state, never its empty-score message.
 *  - `failed`: content is loaded but one of its settings could NOT be read
 *    (its observer's read failed with no last-known value). A display shows
 *    the failure with its Retry, never a spinner.
 *  - `ready`: the composed score (untempo-scaled; the session folds the tempo).
 */
export type DocumentContent =
  | { kind: "empty"; contentKey: object }
  | { kind: "pending"; contentKey: object }
  | { kind: "failed"; contentKey: object; failure: SongSettingFailure }
  | { kind: "ready"; contentKey: object; score: Score };

export interface SongDocumentValue {
  /** Which document is loaded — `null` before any load. */
  identity: SongIdentity | null;
  content: DocumentContent;
  /**
   * Read a specific source's raw input (or `undefined`). Reactive: identity
   * changes whenever any source's raw changes — so a source's own editor
   * section (e.g. the chord-grid editor) re-renders with fresh raw.
   */
  sourceRaw: (sourceId: string) => unknown;
  /**
   * Write a specific source's raw (merges one key) — recompiles the composed
   * score immediately. Used by per-source editor sections. Throws with no
   * document loaded.
   */
  setSourceRaw: (sourceId: string, raw: unknown) => void;
}

const SongDocumentContext = createContext<SongDocumentValue | null>(null);

/** Read the loaded song document. Throws outside `<SongDocumentProvider>`. */
export function useSongDocument(): SongDocumentValue {
  const ctx = useContext(SongDocumentContext);
  if (!ctx) {
    throw new Error(
      "useSongDocument must be used within <SongDocumentProvider>",
    );
  }
  return ctx;
}

/**
 * Provides one surface's song document: the loaded identity, content and
 * per-song settings (one store — see `loaded-song.tsx`) and the score composed
 * from them. Load into it with `useLoadDocument()`.
 */
export function SongDocumentProvider({ children }: { children: ReactNode }) {
  return (
    <LoadedSongProvider>
      <ComposedDocument>{children}</ComposedDocument>
    </LoadedSongProvider>
  );
}

/**
 * Composes the loaded document — a separate component from the store's
 * provider, since a component cannot read a store its own JSX provides.
 *
 * The score is *derived* and *composed*: every source that has raw input is
 * compiled, the compiled Scores are merged via `mergeScores` (so a chord grid
 * and a MIDI file layer into one Score), then the per-song view transforms
 * and every `SonataDocument.Analyzer`'s output are layered on top
 * (`source:"derived"`, never clobbering authored truth).
 */
function ComposedDocument({ children }: { children: ReactNode }) {
  const sources = SonataDocument.Source.useContributions();
  const analyzers = SonataDocument.Analyzer.useContributions();
  // The loaded song's settings the pipeline transforms with (`score-settings.ts`;
  // each feature plugin's observer / its controls write them into the loaded
  // song — see `loaded-song.tsx`), pending until EVERY setting the composition
  // registers has settled for that song, not only these:
  //  - transpose: the global offset in semitones, applied early in `baseScore`
  //    (before re-voicing / inference / spelling) so every downstream consumer —
  //    audio, roll geometry, overlays, key readout — transposes for free;
  //  - key auto-detect: when on, the pipeline ignores the authored key and
  //    infers it from the notes;
  //  - groove: the two-hand rhythm necklace plus each hand's tone-order
  //    figuration id, threaded into `reVoiceChords`. Like voicing, it lands notes
  //    on the chord annotations' EXISTING beats (a bar-anchored groove over the
  //    same timeline), so it belongs in the view layer and never rewinds the
  //    transport. Always present: every song's chords play through a groove;
  //  - chord mode: when on, `baseScore` runs a SECOND re-voicing pass after
  //    chord analysis, so the chords of a song with notes of its own (a MIDI
  //    song's detected ones, a score's authored symbols) become
  //    playable notes on the Chords / Bass tracks — through the same groove a
  //    chord grid uses. A view transform: it lands notes on the
  //    chords' existing beats and never rewinds the transport;
  //  - any other registered setting (the track-mixer's track view): not read by
  //    the pipeline, but part of the gate.
  // A setting whose feature is not in the composition is not waited on, and
  // reads as its `absent` value (the identity transform) — as does every
  // setting of a file document.
  const settings = useScoreSettings();
  // The loaded content: raw input keyed by source id — each source keeps its
  // own input so they accumulate and merge, rather than one active source
  // replacing another. Read from the same state as `settings`: one identity
  // for both, so they can never belong to two songs.
  const rawById = useLoadedRaw();
  const editLoadedRaw = useEditLoadedRaw();
  const loaded = useLoadedDocument();

  // --- The score in two physically separate layers. -------------------------
  //
  // `contentScore` is the loaded TIMELINE and nothing else: compile every source
  // that has input, then merge them (in source-contribution order). Its deps are
  // restricted to the loaded input (`sources`, `rawById`), so by construction it
  // holds NO pitch/spelling/key transform and its identity changes ONLY when the
  // real content changes. It is the content's `contentKey` — what a playback
  // session's reset keys on — and the split is load-bearing precisely because a
  // view-transform *physically cannot* live in this memo, so it can never
  // re-trigger the rewind. A source that authors no tempo/time-sig (e.g. the
  // chord grid emits empty maps) defers to one that does via `mergeScores`'
  // first-non-empty rule — so a merged MIDI file owns the timeline here.
  //
  // Its input is the sources that HOLD input for this document, kept as one
  // value across registry changes that add none: a source plugin registering
  // late (the deferred plugin tier, seconds after a preview mounted) must not
  // re-key the content — that would rewind and stop a session already playing.
  const withInput = sources.filter((s) => rawById[s.id] !== undefined);
  const withInputKey = withInput.map((s) => s.id).join("\n");
  const [activeSources, setActiveSources] = useState({
    key: withInputKey,
    list: withInput,
  });
  if (activeSources.key !== withInputKey) {
    setActiveSources({ key: withInputKey, list: withInput });
  }
  const active =
    activeSources.key === withInputKey ? activeSources.list : withInput;
  const contentScore = useMemo<Score>(() => {
    const compiled = active.map((s) => s.compile(rawById[s.id]));
    if (compiled.length === 0) return emptyScore();
    return mergeScores(compiled);
  }, [active, rawById]);

  // Content is loaded but its song's settings are not all known: the view is
  // withheld until they are. With no content there is nothing to withhold —
  // an empty score is then simply the truth.
  const hasContent = active.length > 0;

  // `content` layers the pure VIEW transforms on top of `contentScore`. Every
  // step here PRESERVES the playable timeline (note onsets, durations, tempo
  // map): it shifts pitches, re-voices chord notes onto the *existing* chord
  // beats, infers the key, spells enharmonics, and analyzes — so the current
  // playhead stays meaningful and these must NEVER rewind. Keeping them in their
  // own memo (deps: the content node + the transform inputs) is what makes the
  // no-rewind invariant structural: a transform added here cannot change
  // `contentScore`'s identity, so a session's reset stays inert to it.
  const content = useMemo<DocumentContent>(() => {
    const contentKey = contentScore;
    if (!hasContent) return { kind: "empty", contentKey };
    // Not one frame of the song under a setting it does not have: until every
    // per-song setting has settled for the loaded song there is no view of it.
    if (settings.kind === "pending") return { kind: "pending", contentKey };
    if (settings.kind === "failed") {
      return {
        kind: "failed",
        contentKey,
        failure: { error: settings.error, refetch: settings.refetch },
      };
    }
    const { transposeSemitones, keyAutoDetect, groove, chordMode, swing } =
      settings.value;
    // Shift the whole song by the per-song transpose offset BEFORE anything else
    // (re-voicing / key inference / spelling / chord analysis all operate on the
    // shifted pitches). No-op at 0 semitones — see `transposeScore`.
    const transposed = transposeScore(contentScore, transposeSemitones);
    // Regenerate chord notes from authored chord annotations under the per-song
    // groove (per-hand rhythm necklace, tone-order figuration and voicing). Runs BEFORE key
    // inference + spelling so the chord notes exist for key detection and get
    // enharmonic spellings. Both voicing and groove land notes on the authored
    // chord annotations' *existing* beats (the groove strikes a bar-anchored
    // pattern over the same timeline), so the timeline span is unchanged — this
    // belongs in the view layer. No-op when there are no authored chord
    // annotations (returns the score unchanged). Only a chord-only song gets
    // this pass: a song with notes of its own (MIDI, MusicXML, a transcription)
    // keeps its chord symbols as labels, voiced only under chord mode below —
    // otherwise the Chords / Bass tracks would double music the score already
    // plays.
    const voiced = hasOwnNotes(transposed)
      ? transposed
      : reVoiceChords(transposed, groove);
    // Two pure pre-analysis steps establish key context: inferKeys derives the
    // tonal centre(s) from the notes (when no key is authored), then spellScore
    // fills each note's enharmonic `spelling` from the key in force. Order
    // matters — inference first, so both note-spelling and the chord analyzer
    // (which reads `effectiveKeyAt`) see the key.
    // `force` ignores any authored key (strips meta.key + authored key
    // annotations) so the song is treated as keyless and the key is inferred —
    // the per-song "auto-detect key" override.
    const keyed = inferKeys(voiced, { force: keyAutoDetect }); // theory/core
    const spelled = spellScore(keyed); // score/core
    // Analyzers read live note PITCHES (chord detection) and the inferred key, so
    // they must run after transpose / voicing / inference — they are part of the
    // view layer, not the content timeline.
    const derived = analyzers.flatMap((a) => a.analyze(spelled));
    const analyzed = mergeAnnotations(spelled, derived);
    // The per-song swing override is META-only (`meta.swing`, the feel the
    // audio layer plays the straight notes with), so it is the last step: no
    // note moves, the timeline is untouched.
    if (!chordMode)
      return {
        kind: "ready",
        contentKey,
        score: applySwingOverride(analyzed, swing),
      };
    // Chord mode: voice EVERY chord annotation — the analyzer-derived ones the
    // MIDI notes just yielded, and the authored symbols of a song with notes of
    // its own, included — onto the Chords / Bass tracks, in one
    // pass so voice-leading stays continuous across authored and detected
    // chords. It must run AFTER analysis (detection needs the original notes,
    // which stay in the score; the track-mixer hides/mutes them) and re-spells
    // so the new chord notes get enharmonics too (`spellScore` leaves
    // already-spelled notes untouched, so this is idempotent). Same beats, same
    // timeline span — a view transform, like everything else in this memo.
    return {
      kind: "ready",
      contentKey,
      score: applySwingOverride(
        spellScore(reVoiceChords(analyzed, groove, { include: "all" })),
        swing,
      ),
    };
  }, [contentScore, hasContent, analyzers, settings]);

  // Source-keyed raw read. Recreated when `rawById` changes so consumers re-render
  // with fresh raw (e.g. the chord-grid editor reflecting a hydrated song).
  const sourceRaw = useCallback(
    (sourceId: string) => rawById[sourceId],
    [rawById],
  );

  const identity = loaded?.identity ?? null;
  const value = useMemo<SongDocumentValue>(
    () => ({ identity, content, sourceRaw, setSourceRaw: editLoadedRaw }),
    [identity, content, sourceRaw, editLoadedRaw],
  );

  return (
    <SongDocumentContext.Provider value={value}>
      {children}
    </SongDocumentContext.Provider>
  );
}
