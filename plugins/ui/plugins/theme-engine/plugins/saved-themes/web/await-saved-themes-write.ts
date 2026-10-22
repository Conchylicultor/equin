import { useCallback } from "react";
import { useAwaitResourceWrite } from "@plugins/primitives/plugins/optimistic-mutation/web";
import { savedThemesList } from "../shared/resources";

/** Resolve once the live theme list has re-read the write acked `watermark`. */
export type AwaitSavedThemesWrite = (watermark: string) => Promise<void>;

/**
 * Resolve once the subtree's live theme list (`saved-themes.list`) has re-read
 * the saved-themes write whose ack token is `watermark` (a `SavedThemeWrite`'s,
 * or a delete's) — so a caller that saved a theme can select it, or one that
 * deleted a theme can report it gone, without a frame where the painter's
 * theme list disagrees. Rejects with the list's read error if it fails before
 * confirming, so the caller reports it instead of hanging.
 *
 * optimistic-mutation's `useAwaitResourceWrite` on the list, bound to the
 * enclosing live-state pipeline. The resident read (`useSavedThemes`, mounted
 * at the root by the painter) asks for standalone ack frames, so a write that
 * leaves the list unchanged (re-importing an identical theme) still confirms.
 * Stable per pipeline.
 */
export function useAwaitSavedThemesWrite(): AwaitSavedThemesWrite {
  const awaitResourceWrite = useAwaitResourceWrite();
  return useCallback(
    (watermark: string) => awaitResourceWrite(savedThemesList, watermark),
    [awaitResourceWrite],
  );
}
