import { useSongDocument } from "@plugins/apps/plugins/sonata/plugins/document/web";
import { UltimateGuitarLoader } from "../loader";
import { UG_SOURCE_ID } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/tab/core";

/**
 * In-player editor for an Ultimate Guitar song, contributed to `Sonata.Section`
 * (`area: "editor"`). Mounts the `UltimateGuitarLoader`, writing the fetched
 * `UgTab` straight into the context as the raw's `tab` (`editSourceRaw` → live
 * score recompile).
 *
 * This component no longer persists or gates:
 * - **Persistence** lives in the headless, always-mounted
 *   `UltimateGuitarPersistObserver` (`Sonata.Effect`). It must stay outside this
 *   body because the section body is unmounted while its card is collapsed, so an
 *   in-body debounced save would be dropped on collapse.
 * - **Visibility** is the contribution's `useAvailable` gate (raw defined ⇒ this
 *   is a UG song), so the card never appears for other sources.
 *
 * There is NO title input — a UG song is imported, not authored, so its title
 * derives from the tab's `songName`, persisted by the observer's `PUT`.
 *
 * Because the gate guarantees the raw is defined by the time this renders, a
 * missing raw here is a genuine invariant violation — we throw loudly rather than
 * paper over it with a non-null assertion or a silent `null`.
 */
export function UltimateGuitarEditorSection() {
  const { sourceRaw, editSourceRaw } = useSongDocument();

  const rawValue = sourceRaw(UG_SOURCE_ID);
  if (rawValue === undefined) {
    throw new Error(
      "UltimateGuitarEditorSection rendered without Ultimate Guitar raw — the section gate (useAvailable) should prevent this.",
    );
  }

  return (
    <UltimateGuitarLoader
      raw={rawValue}
      onRaw={(r) => editSourceRaw(UG_SOURCE_ID, () => r)}
    />
  );
}
