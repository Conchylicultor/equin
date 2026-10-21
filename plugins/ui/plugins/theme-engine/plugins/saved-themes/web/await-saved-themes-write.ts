import { awaitResourceWrite } from "@plugins/primitives/plugins/optimistic-mutation/web";
import { savedThemesList } from "../shared/resources";

/**
 * Resolve once the page's live theme list (`saved-themes.list`) has re-read
 * the saved-themes write whose ack token is `watermark` (a `SavedThemeWrite`'s,
 * or a delete's) — so a caller that saved a theme can select it, or one that
 * deleted a theme can report it gone, without a frame where the painter's
 * theme list disagrees. Rejects with the list's read error if it fails before
 * confirming, so the caller reports it instead of hanging.
 *
 * optimistic-mutation's `awaitResourceWrite` on the list. The resident read
 * (`useSavedThemes`, mounted at the root by the painter) asks for standalone
 * ack frames, so a write that leaves the list unchanged (re-importing an
 * identical theme) still confirms.
 */
export function awaitSavedThemesWrite(watermark: string): Promise<void> {
  return awaitResourceWrite(savedThemesList, watermark);
}
