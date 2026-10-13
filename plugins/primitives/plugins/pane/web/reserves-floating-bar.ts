import { useContext } from "react";
import { PaneLayoutContext } from "./maximize-context";
import { SurfaceChromeContext } from "./surface-chrome-context";

/**
 * Whether a bar rendered here sits at the surface's top-right corner — under
 * the global floating action bar — and so must reserve its safe area
 * (`pr-floating-bar-pane`) and name itself the bar's anchor
 * (`anchor-floating-bar-band`, which centres the floating bar on its line).
 *
 * True when the pane's content owns the surface's top chrome (no app-shell
 * toolbar above it) and the pane is the surface's end (rightmost) column. The
 * one answer for every top bar a pane can show: its own header (`PaneChrome`)
 * or a bar its body draws in place of one (the DataView floating toolbar).
 */
export function useReservesFloatingBar(): boolean {
  const layoutCtx = useContext(PaneLayoutContext);
  const { contentOwnsTopChrome } = useContext(SurfaceChromeContext);
  return contentOwnsTopChrome && layoutCtx?.atSurfaceEnd === true;
}
