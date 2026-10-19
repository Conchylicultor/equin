import { useEffect, useState } from "react";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";

const fullscreenIcon = symbol("fullscreen");
const exitFullscreenIcon = symbol("fullscreen-exit");

/** Tracks the document's fullscreen state, kept in sync via `fullscreenchange`. */
function useIsFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(
    () => document.fullscreenElement !== null,
  );
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  return isFullscreen;
}

/** Enter browser fullscreen, or leave it when already there. */
function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen();
}

/**
 * Browser fullscreen as a toolbar button, for an app that puts it in its own
 * header (the Sonata player's toolbar) rather than the action bar's popover.
 */
export function FullscreenButton() {
  const isFullscreen = useIsFullscreen();
  return (
    <IconButton
      icon={isFullscreen ? exitFullscreenIcon : fullscreenIcon}
      label={isFullscreen ? "Exit full screen" : "Full screen"}
      onClick={toggleFullscreen}
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
  const isFullscreen = useIsFullscreen();

  return (
    <ControlPanel.Row
      icon={<Icon icon={fullscreenIcon} />}
      select="switch"
      checked={isFullscreen}
      onSelect={toggleFullscreen}
    >
      Browser fullscreen
    </ControlPanel.Row>
  );
}
