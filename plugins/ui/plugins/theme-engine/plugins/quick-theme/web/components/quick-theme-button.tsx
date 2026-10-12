import { useState } from "react";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { ControlPanelPopover } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { useActiveApp } from "@plugins/apps-core/web";
import { appLink } from "@plugins/apps-core/plugins/tabs/web";
import { afterOpen } from "@plugins/primitives/plugins/link-gesture/core";
import { themeCustomizerRoute } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { QuickThemePanel } from "./quick-theme-panel";
import { symbol } from "@plugins/ui/plugins/icons/core";

const paletteIcon = symbol("palette");

/**
 * Toolbar entry point for theming, surfaced in every app via `ActionBar.Item`
 * (the docked tab-bar strip and the floating bar). It opens the quick-switch
 * popover so a theme change never costs the user their current pane; the full
 * customizer is one click further, behind the panel's footer.
 *
 * Both mount points render OUTSIDE every `<PaneSurfaceProvider>`, so this has no
 * pane store — `useOpenPane()` would throw. Global chrome navigates through the
 * cross-app `navigate()` (as an `appLink`). The customizer opens in the ACTIVE app (it styles that
 * app's theme scope), so the link is the active app's base path plus the route's
 * own segment.
 */
export function QuickThemeButton() {
  const [open, setOpen] = useState(false);
  const activeApp = useActiveApp();

  // Closing the popover rides the plain open only: an "elsewhere" gesture
  // leaves this tab, and so this popover, where it is.
  const editor = afterOpen(
    appLink(`${activeApp?.app.basePath ?? ""}${themeCustomizerRoute.path({})}`),
    () => setOpen(false),
  );

  return (
    <ControlPanelPopover
      open={open}
      onOpenChange={setOpen}
      align="end"
      side="bottom"
      // The body is a GRID of theme swatches — the `picker` role. There is no
      // width prop to smuggle a measurement through, which is the point: the
      // panel used to be 480px because that is what the catalog gallery wanted.
      size="picker"
      label="Theme"
      trigger={
        <IconButton
          icon={paletteIcon}
          label="Theme"
          variant={open ? "secondary" : "ghost"}
        />
      }
    >
      <QuickThemePanel editor={editor} />
    </ControlPanelPopover>
  );
}
