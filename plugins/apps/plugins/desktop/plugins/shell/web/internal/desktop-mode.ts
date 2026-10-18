import {
  getSurfaceMode,
  useSurfaceMode,
} from "@plugins/apps-core/plugins/tabs/web";
import { DESKTOP_PLACEMENT_ID } from "../../core";

/** One-shot: whether the surface is in desktop mode — for shortcut `when`
 * gates and event handlers. Never from render: use {@link useDesktopActive}. */
export function isDesktopActive(): boolean {
  return getSurfaceMode() === DESKTOP_PLACEMENT_ID;
}

/** Reactive: whether the surface is in desktop mode. */
export function useDesktopActive(): boolean {
  return useSurfaceMode() === DESKTOP_PLACEMENT_ID;
}
