import { useSongDocument } from "@plugins/apps/plugins/sonata/plugins/document/web";
import { ChordGridLoader } from "../loader";
import { CHORD_GRID_SOURCE_ID } from "../constants";

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
    />
  );
}
