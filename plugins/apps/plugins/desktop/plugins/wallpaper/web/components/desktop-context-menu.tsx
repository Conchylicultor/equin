import { useState } from "react";
import type { MouseEvent } from "react";
import { DropdownMenuItem } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  CursorAnchoredMenu,
  type CursorAnchor,
} from "@plugins/primitives/plugins/overlay/plugins/cursor-menu/web";
import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import {
  wallpaperConfig,
  DEFAULT_WALLPAPER_ID,
  isDefaultWallpaper,
} from "../../core";
import { openWallpaperPicker } from "./wallpaper-picker";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const imageIcon = symbol("image");
const restartAltIcon = symbol("restart-alt");

/**
 * The desktop context menu host: a transparent full-surface capture layer that
 * opens a cursor-anchored menu on right-click of the empty desktop. Owns the
 * config read/write (whether an image is set, the reset action) and the cursor
 * anchor; delegates the actual menu chrome to {@link DesktopContextMenuContent},
 * which renders no config so the config-picker lint rule (rightly) doesn't apply
 * — this is a desktop affordance, not a config-editing picker.
 *
 * The capture layer is mounted as the FIRST child of the floating backdrop (below
 * the dock + windows), so a right-click on a window hits that window's own system
 * menu instead — only the empty desktop reaches here. The cursor-anchored menu
 * itself is the shared {@link CursorAnchoredMenu} primitive, which body-portals its
 * zero-size anchor so `position: fixed` escapes the backdrop's `transform-gpu`.
 */
export function DesktopContextMenu() {
  const [anchor, setAnchor] = useState<CursorAnchor | null>(null);
  const { state } = useConfig(wallpaperConfig);
  const setConfig = useSetConfig(wallpaperConfig);

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    setAnchor({ x: e.clientX, y: e.clientY });
  };

  const resetToDefault = () => {
    setConfig("state", {
      kind: "builtin",
      id: DEFAULT_WALLPAPER_ID,
      version: state.version,
      mime: "",
      attribution: {},
    });
  };

  return (
    <>
      {/* Transparent full-surface right-click capture layer for the empty desktop.
          Carries no visual; only the handler. */}
      <div
        aria-hidden
        onContextMenu={onContextMenu}
        // eslint-disable-next-line layout/no-adhoc-layout -- transparent full-bleed right-click capture layer for the empty desktop; it is itself the absolute backdrop-level layer, not an Overlay wrapping content
        className="absolute inset-0"
      />
      <DesktopContextMenuContent
        anchor={anchor}
        onClose={() => setAnchor(null)}
        canReset={!isDefaultWallpaper(state)}
        onReset={resetToDefault}
      />
    </>
  );
}

/**
 * The presentational cursor-anchored desktop menu. Pure chrome — it reads no
 * config; the host passes the resolved `canReset` flag (the wallpaper is not the default) + the reset action.
 */
function DesktopContextMenuContent({
  anchor,
  onClose,
  canReset,
  onReset,
}: {
  anchor: CursorAnchor | null;
  onClose: () => void;
  canReset: boolean;
  onReset: () => void;
}) {
  return (
    <CursorAnchoredMenu anchor={anchor} onClose={onClose}>
      <DropdownMenuItem onClick={openWallpaperPicker}>
        <Icon icon={imageIcon} />
        Change wallpaper…
      </DropdownMenuItem>
      {canReset && (
        <DropdownMenuItem onClick={onReset}>
          <Icon icon={restartAltIcon} />
          Reset to default
        </DropdownMenuItem>
      )}
    </CursorAnchoredMenu>
  );
}
