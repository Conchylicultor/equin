import {
  getEndpointErrorMessage,
  useEndpointMutation,
} from "@plugins/infra/plugins/endpoints/web";
import { useLive } from "@plugins/network/plugins/live/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import type { LoopExtras } from "@plugins/apps/plugins/chord/plugins/song-index/core";
import {
  chordCatalog,
  chordCurriculum,
  setBlanksEndpoint,
  setChordsEndpoint,
  setExtrasEndpoint,
  type Blanks,
  type CatalogState,
  type ChordChange,
  type Selection,
} from "../../core";

// ── Reading and changing the selection from the browser ──────────────────────
//
// The selection is live (the server pushes every change), so the writes answer
// nothing: `chordCurriculum` brings the new value to every open tab. A refused
// write is a toast with the server's sentence, never a silent nothing.

/** What the learner has chosen. `loading` until the server's first value lands. */
export function useCurriculum(): ResourceResult<Selection> {
  return useLive(chordCurriculum);
}

/**
 * Every chord of the song index, in tracks and sections. `loading` until the
 * first value lands; then `not-ready` until the index is loaded — both are a
 * loading state to render, never an empty catalog.
 */
export function useCatalog(): ResourceResult<CatalogState> {
  return useLive(chordCatalog);
}

/** The three writes. Each takes an optional `onDone`, called once the server has applied it. */
export type CurriculumWrites = {
  /** Chords to practise, hear only or turn off, applied in order (one chip, a section, a group, Clear, Undo). */
  setChords: (changes: readonly ChordChange[], onDone?: () => void) => void;
  setBlanks: (blanks: Blanks, onDone?: () => void) => void;
  setExtras: (extras: LoopExtras, onDone?: () => void) => void;
};

export function useCurriculumWrites(): CurriculumWrites {
  const onError = (err: Parameters<typeof getEndpointErrorMessage>[0]) =>
    showToast({
      title: "Your practice settings could not be changed",
      description: getEndpointErrorMessage(err),
      variant: "error",
    });
  const chords = useEndpointMutation(setChordsEndpoint, { onError });
  const blanks = useEndpointMutation(setBlanksEndpoint, { onError });
  const extras = useEndpointMutation(setExtrasEndpoint, { onError });
  return {
    setChords: (changes, onDone) =>
      chords.mutate(
        { body: { changes: [...changes] } },
        { onSuccess: () => onDone?.() },
      ),
    setBlanks: (value, onDone) =>
      blanks.mutate(
        { body: { blanks: value } },
        { onSuccess: () => onDone?.() },
      ),
    setExtras: (value, onDone) =>
      extras.mutate(
        { body: { extras: value } },
        { onSuccess: () => onDone?.() },
      ),
  };
}
