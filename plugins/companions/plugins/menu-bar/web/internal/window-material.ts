import { useEffect } from "react";
import type { NativeMaterial } from "../../core";
import { useNativeHost } from "../native-host";

/**
 * The helper's window material, when the panel window is a transparent one
 * (macOS vibrancy): `{ cornerRadius }` — the corners the page must clip to —
 * else `null` (a browser, an opaque square window, or the bridge still
 * answering). While it holds, the document paints no background of its own
 * (`html[data-window-material]`, window-material.css), so the material shows
 * through the panel's translucent fill.
 */
export function useWindowMaterial(): NativeMaterial | null {
  const host = useNativeHost();
  const material = host.kind === "present" ? host.material : null;
  const on = material !== null;
  useEffect(() => {
    if (!on) return;
    const root = document.documentElement;
    root.setAttribute("data-window-material", "");
    return () => root.removeAttribute("data-window-material");
  }, [on]);
  return material;
}
