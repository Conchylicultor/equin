import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useBrowserValue } from "@plugins/primitives/plugins/dom/plugins/render-mode/web";
import {
  useFullscreenSupport,
  type FullscreenSupport,
} from "@plugins/primitives/plugins/dom/plugins/element-fullscreen/web";

const fullscreenIcon = symbol("fullscreen");
const exitFullscreenIcon = symbol("fullscreen-exit");

function subscribeFullscreen(onChange: () => void): () => void {
  document.addEventListener("fullscreenchange", onChange);
  return () => document.removeEventListener("fullscreenchange", onChange);
}
const readIsFullscreen = (): boolean => document.fullscreenElement !== null;

/** The document's fullscreen state, kept in sync via `fullscreenchange`; never fullscreen in a static render. */
function useIsFullscreen() {
  return useBrowserValue({
    name: "document.fullscreenElement",
    read: readIsFullscreen,
    subscribe: subscribeFullscreen,
    staticValue: false,
  });
}

/** Enter browser fullscreen, or leave it when already there. */
function toggleFullscreen(support: FullscreenSupport & { kind: "supported" }) {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void support.request(document.documentElement);
}

/**
 * Browser fullscreen as a toolbar button, for an app that puts it in its own
 * header (the Sonata player's toolbar) rather than the action bar's popover.
 * Drawn only where the browser has element fullscreen.
 */
export function FullscreenButton() {
  const support = useFullscreenSupport();
  const isFullscreen = useIsFullscreen();
  // No element fullscreen here (an iPhone): nothing to offer.
  if (support.kind === "unsupported") return null;
  return (
    <IconButton
      icon={isFullscreen ? exitFullscreenIcon : fullscreenIcon}
      label={isFullscreen ? "Exit full screen" : "Full screen"}
      onClick={() => toggleFullscreen(support)}
    />
  );
}

/**
 * Browser fullscreen as a switch row in the action bar's view-options popover.
 * Named "Browser fullscreen" because the surface-mode control in the same
 * popover has its own "Fullscreen (solo)" mode, which fills the window rather
 * than the screen.
 */
export function FullscreenToggle() {
  const support = useFullscreenSupport();
  const isFullscreen = useIsFullscreen();
  if (support.kind === "unsupported") return null;

  return (
    <ControlPanel.Row
      icon={<Icon icon={fullscreenIcon} />}
      select="switch"
      checked={isFullscreen}
      onSelect={() => toggleFullscreen(support)}
    >
      Browser fullscreen
    </ControlPanel.Row>
  );
}
