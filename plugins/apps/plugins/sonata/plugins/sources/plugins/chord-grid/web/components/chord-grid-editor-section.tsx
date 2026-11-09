import { useSongDocument } from "@plugins/apps/plugins/sonata/plugins/document/web";
import { useCursorSelector } from "@plugins/apps/plugins/sonata/plugins/session/web";
import { slotAt, type GridSlot } from "../../core";
import { ChordGridLoader } from "../loader";
import { CHORD_GRID_SOURCE_ID } from "../constants";

/**
 * The grid slot under the session's playhead — none while an A–B loop's rest
 * runs (nothing sounds yet). Returns the slot's stable reference from the
 * parse, so the editor re-renders only when the playhead crosses a slot.
 */
function usePlayheadSlot(slots: readonly GridSlot[]): GridSlot | null {
  return useCursorSelector(
    (beat, position) => (position.rest > 0 ? null : slotAt(slots, beat)),
    [slots],
  );
}

/**
 * In-player editor for a chord-grid song, contributed to `Sonata.Section`
 * (`area: "editor"`). Mounts the `ChordGridLoader`, writing edits straight into
 * the context (`editSourceRaw` → live score recompile).
 *
 * This component no longer persists or gates:
 * - **Persistence** lives in the headless, always-mounted
 *   `ChordGridPersistObserver` (`Sonata.Effect`). It must stay outside this body
 *   because the section body is unmounted while its card is collapsed, so an
 *   in-body debounced save would be dropped on collapse.
 * - **Visibility** is the contribution's `useAvailable` gate (raw defined ⇒ this
 *   is a chord-grid song), so the card never appears for other sources.
 *
 * Because the gate guarantees the raw is defined by the time this renders, a
 * missing raw here is a genuine invariant violation — we throw loudly rather than
 * paper over it with a non-null assertion or a silent `null`.
 */
export function ChordGridEditorSection() {
  const { sourceRaw, editSourceRaw } = useSongDocument();

  const rawValue = sourceRaw(CHORD_GRID_SOURCE_ID);
  if (rawValue === undefined) {
    throw new Error(
      "ChordGridEditorSection rendered without chord-grid raw — the section gate (useAvailable) should prevent this.",
    );
  }

  return (
    <ChordGridLoader
      raw={rawValue}
      onRaw={(r) => editSourceRaw(CHORD_GRID_SOURCE_ID, () => r)}
      usePlayingSlot={usePlayheadSlot}
    />
  );
}
