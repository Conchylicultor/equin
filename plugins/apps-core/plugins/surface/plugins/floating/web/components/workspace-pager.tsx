import { useMemo } from "react";
import { useTabs } from "@plugins/apps-core/plugins/tabs/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  ControlSizeProvider,
  WithTooltip,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  hoverRevealClass,
  useHoverReveal,
} from "@plugins/primitives/plugins/hover-reveal/web";
import {
  createDesktop,
  removeDesktop,
  setActiveDesktop,
  topmostWindowOnDesktop,
  useDesktops,
  useFloatingWindows,
  type Desktop,
  type FloatingWindow,
} from "../hooks/use-floating-windows";
import { DesktopMinimap } from "./desktop-minimap";
import { symbol } from "@plugins/ui/plugins/icons/core";

const addIcon = symbol("add");
const closeIcon = symbol("close");

/**
 * The virtual-desktop (workspace) pager — a compact row of **miniature desktops**
 * composed into the LEFT of the floating dock bar (one cohesive bottom shelf, the
 * KDE / ChromeOS pattern). Each pill is a {@link DesktopMinimap}: a small frame
 * standing in for that desktop, with every window on it drawn at its real
 * position/size, so the switcher reads as a spatial overview rather than a bare
 * `1 / 2 / 3` index (the macOS Spaces / Win11 Task View thumbnail idiom). It
 * honours the passive-backdrop invariant: it organizes windows and lives in
 * chrome (the dock), it is never an app launcher and is never painted onto the
 * wallpaper.
 *
 * One pill per desktop, active when it's the live desktop; clicking switches to
 * it and focuses its topmost window. A pill reveals a small × on hover (only when
 * more than one desktop exists) to remove it. A trailing "+" creates a desktop
 * and switches to it. The desktop list + each desktop's windows come straight
 * from the window store, so the pager (and every thumbnail) re-renders with it.
 * `desktopW`/`desktopH` (the measured backdrop, threaded from {@link WindowDock})
 * scale each free window into a desktop fraction inside the thumbnails.
 */
export function WorkspacePager({
  desktopW,
  desktopH,
}: {
  desktopW: number;
  desktopH: number;
}) {
  const { desktops, activeDesktopId } = useDesktops();
  const windows = useFloatingWindows();
  const { focusedTabId, focusTab } = useTabs();

  // Windows grouped by desktop, so each thumbnail draws only its own windows.
  const byDesktop = useMemo(() => {
    const m = new Map<string, FloatingWindow[]>();
    for (const win of windows.values()) {
      const list = m.get(win.desktopId);
      if (list) list.push(win);
      else m.set(win.desktopId, [win]);
    }
    return m;
  }, [windows]);

  const onCreate = () => {
    const id = createDesktop({ activate: true });
    // A freshly-created desktop is empty, so there is no window to focus.
    const top = topmostWindowOnDesktop(id);
    if (top) focusTab(top.activeTabId);
  };

  return (
    <Cluster gap="2xs">
      {desktops.map((desktop, index) => (
        <DesktopPill
          key={desktop.id}
          desktop={desktop}
          index={index}
          active={desktop.id === activeDesktopId}
          windows={byDesktop.get(desktop.id) ?? []}
          desktopW={desktopW}
          desktopH={desktopH}
          focusedTabId={focusedTabId}
          removable={desktops.length > 1}
          onSwitch={() => {
            setActiveDesktop(desktop.id);
            const top = topmostWindowOnDesktop(desktop.id);
            if (top) focusTab(top.activeTabId);
          }}
        />
      ))}
      <ControlSizeProvider size="sm">
        <IconButton icon={addIcon} label="New desktop" onClick={onCreate} />
      </ControlSizeProvider>
    </Cluster>
  );
}

/**
 * One desktop pill: a clickable {@link DesktopMinimap} thumbnail with a
 * hover-revealed × delete affordance. The thumbnail carries the active read (its
 * own primary ring); this wrapper carries the click + `aria-pressed` and the
 * tooltip ("Desktop N · k window(s)"). The reveal uses {@link useHoverReveal} so
 * the hidden × is never a live click-target beside the thumbnail.
 */
function DesktopPill({
  desktop,
  index,
  active,
  windows,
  desktopW,
  desktopH,
  focusedTabId,
  removable,
  onSwitch,
}: {
  desktop: Desktop;
  index: number;
  active: boolean;
  windows: FloatingWindow[];
  desktopW: number;
  desktopH: number;
  focusedTabId: string | null;
  removable: boolean;
  onSwitch: () => void;
}) {
  const { revealed, groupProps } = useHoverReveal();
  const label = `Desktop ${index + 1}`;
  const count = windows.filter((w) => !w.geo.minimized).length;
  const tooltip = `${label} · ${count} window${count === 1 ? "" : "s"}`;

  return (
    <Stack direction="row" align="center" gap="2xs" {...groupProps}>
      <WithTooltip content={tooltip}>
        {/* A plain button wrapping the mini-desktop thumbnail: the thumbnail shows
            active state (primary ring) and the desktop's windows; this carries the
            switch click + a11y. The bare number moves to the tooltip / aria-label. */}
        <button
          type="button"
          onClick={onSwitch}
          aria-label={tooltip}
          aria-pressed={active}
          className="rounded-md"
        >
          <DesktopMinimap
            windows={windows}
            desktopW={desktopW}
            desktopH={desktopH}
            active={active}
            focusedTabId={focusedTabId}
            index={index}
          />
        </button>
      </WithTooltip>
      {removable && (
        <span className={hoverRevealClass(revealed)}>
          <ControlSizeProvider size="sm">
            <IconButton
              icon={closeIcon}
              label={`Close ${label}`}
              onClick={(e) => {
                e.stopPropagation();
                removeDesktop(desktop.id);
              }}
            />
          </ControlSizeProvider>
        </span>
      )}
    </Stack>
  );
}
