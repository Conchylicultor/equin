import { useEffect } from "react";
import { useStaleFrontend } from "@plugins/build/web";
import { clientLog } from "@plugins/primitives/plugins/log-channels/web";
import { useNativeHost } from "../native-host";

/**
 * The helper keeps the panel page alive while hidden, for days — and a web-only
 * push to main does not restart the helper (it follows main only when its own
 * `rust/` changes). The panel is chromeless, so the Reload pill every other
 * page shows when its bundle is out of date is not drawn here. Left alone, the
 * panel would run the web it first loaded until the next helper restart.
 *
 * So the panel reloads itself once its bundle is stale — only while its window
 * is hidden (the helper's hide orders the window out; WebKit then reports the
 * document hidden), never under the user's eyes: stale while open, it reloads
 * at the next hide. The typed text survives (`usePanelInput` is a draft).
 */
export function StaleReload() {
  const host = useNativeHost();
  const { stale, serverGraph } = useStaleFrontend();
  const inHelper = host.kind === "present";
  useEffect(() => {
    if (!inHelper || !stale) return;
    const reloadIfHidden = () => {
      if (document.visibilityState !== "hidden") return;
      clientLog(
        "menu-bar",
        `panel bundle is stale (server graph ${serverGraph}); reloading while hidden`,
      );
      window.location.reload();
    };
    reloadIfHidden();
    document.addEventListener("visibilitychange", reloadIfHidden);
    return () =>
      document.removeEventListener("visibilitychange", reloadIfHidden);
  }, [inHelper, stale, serverGraph]);
  return null;
}
