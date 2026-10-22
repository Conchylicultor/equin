import {
  useResourceAcks,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import type { Theme } from "@plugins/ui/plugins/theme-engine/core";
import { savedThemesList } from "../../shared/resources";

// The resident source's read: the saved rows are already `Theme`s on the wire.
// Hydrated by the boot snapshot (`preload: "boot-and-keep"`), so it is settled
// on the first render after a successful boot — loading only when the boot
// hydration missed, never a final empty list — and a failed read is its own
// state, so the gallery can say so instead of spinning forever.
//
// It also asks for standalone ack frames on the list for as long as it is
// mounted: `useAwaitSavedThemesWrite` confirms a write by its ack, and a write
// that leaves the list unchanged (an identical re-import) ships no value frame.
export function useSavedThemes(): ResourceResult<Theme[]> {
  useResourceAcks(savedThemesList);
  return useLive(savedThemesList);
}
