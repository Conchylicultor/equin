import { CompanionPanel } from "@plugins/companions/plugins/panel/web";
import { MenuBar } from "../slots";
import { useNativeHost } from "../native-host";
import { useWindowMaterial } from "../internal/window-material";
import { StaleReload } from "../internal/stale-reload";
import "../internal/window-material.css";

/**
 * The menu-bar panel: the page the native helper's panel window loads
 * (`/home/menu-bar?embed=1` — chromeless, so no rail, tab bar or action bar).
 * It is the WHOLE menu-bar app (`menuBarApp`) — the app's own layout, not a
 * pane: a pane always draws its header, which sat behind the panel and showed
 * through its translucent fill.
 *
 * The companions' panel over the `MenuBar.Section` slot, plus what only the
 * helper does: the window material's corners, the window following the
 * content's height, the status line's attention as the menu-bar icon's dot,
 * the `MenuBar.Mount` work, and reloading itself while hidden once main serves
 * a newer web bundle (`StaleReload`).
 */
export function MenuBarPanel() {
  // On a transparent helper window the panel is the material's rounded fill.
  const material = useWindowMaterial();
  const host = useNativeHost();
  const present = host.kind === "present" ? host : null;
  const setPanelHeight = present?.setPanelHeight ?? null;
  const setAttention = present?.setAttention ?? null;
  return (
    <CompanionPanel
      sections={MenuBar.Section}
      style={
        material === null ? undefined : { borderRadius: material.cornerRadius }
      }
      onContentHeight={
        setPanelHeight === null ? null : (px) => void setPanelHeight(px)
      }
      onAttention={setAttention === null ? null : (on) => void setAttention(on)}
    >
      <MenuBar.Mount.Mount />
      <StaleReload />
    </CompanionPanel>
  );
}
