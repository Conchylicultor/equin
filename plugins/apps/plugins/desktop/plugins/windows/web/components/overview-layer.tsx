import type { CSSProperties } from "react";
import { Apps } from "@plugins/apps-core/web";
import { useTabs } from "@plugins/apps-core/plugins/tabs/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { useFloatingWindows } from "../hooks/use-floating-windows";
import { useOverviewSlots } from "../internal/overview";
import { exitOverview } from "../window-commands";

/** The window corner (mockup `--r-win`), scaled with each window. */
const WINDOW_RADIUS = 12;
/** The hover ring's width in window pixels (mockup `.is-overview .win:hover::after`). */
const RING = 4;

/**
 * The overview label's look (mockup `.ov-label`): a dark frosted pill over the
 * blurred wallpaper — literal, as no theme token is "a caption on a wallpaper".
 */
const LABEL_STYLE = {
  padding: "4px 10px",
  background: "rgba(20, 22, 28, 0.6)",
  backdropFilter: "blur(12px)",
  WebkitBackdropFilter: "blur(12px)",
  transform: "translateX(-50%)",
} as const;

/**
 * The overview's own layer — the windows themselves glide into the grid (each
 * window's motion reads its slot); this draws what goes around them while it is
 * open: one click target per window at its place in the grid (hover rings it
 * in the accent, a click picks it), its "App — title" label underneath, and a
 * full-bleed catcher behind them, so a click on the empty desktop leaves the
 * overview (Esc is the `desktop.overview-exit` shortcut).
 */
export function OverviewLayer() {
  const slots = useOverviewSlots();
  const windows = useFloatingWindows();
  const { tabs, titles } = useTabs();
  const apps = Apps.App.useContributions();

  if (!slots) return null;

  return (
    <div
      onClick={() => exitOverview()}
      // eslint-disable-next-line layout/no-adhoc-layout -- full-bleed click catcher over the desktop while the overview is open; its children are placed from the overview layout, so no positioning primitive applies
      className="absolute inset-0 z-float cursor-default"
    >
      {[...slots.values()].map((slot) => {
        const win = windows.get(slot.id);
        if (!win) return null;
        const appId = tabs.find((t) => t.tabId === win.activeTabId)?.appId;
        const appName = apps.find((a) => a.id === appId)?.app.name ?? "Window";
        const label = `${appName} — ${titles[win.activeTabId] ?? appName}`;
        return (
          <div key={slot.id}>
            <button
              type="button"
              aria-label={label}
              onClick={(e) => {
                e.stopPropagation();
                exitOverview(slot.id);
              }}
              // eslint-disable-next-line layout/no-adhoc-layout -- the click target over a window's place in the overview grid, positioned from the layout
              className="absolute transition-shadow duration-150 hover:shadow-[inset_0_0_0_var(--ov-ring)_var(--primary)]"
              style={
                {
                  left: slot.rect.x,
                  top: slot.rect.y,
                  width: slot.rect.w,
                  height: slot.rect.h,
                  borderRadius: WINDOW_RADIUS * slot.scale,
                  "--ov-ring": `${RING * slot.scale}px`,
                } as CSSProperties
              }
            />
            <Text
              variant="label"
              // eslint-disable-next-line layout/no-adhoc-layout -- the window's label under its place in the overview grid, positioned from the layout
              className="pointer-events-none absolute whitespace-nowrap rounded-full text-white animate-in fade-in-0 duration-200 delay-150 fill-mode-backwards"
              style={{ ...LABEL_STYLE, left: slot.label.x, top: slot.label.y }}
            >
              {label}
            </Text>
          </div>
        );
      })}
    </div>
  );
}
