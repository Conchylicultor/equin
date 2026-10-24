import { useRef } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { menuBarApp } from "../../core";
import { SurfaceOverlay } from "@plugins/primitives/plugins/overlay/plugins/surface-overlay/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import {
  Stack,
  insetClass,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { MenuBar } from "../slots";
import { useNativeHost } from "../native-host";
import { PanelStatus } from "../internal/panel-status";

/**
 * The menu-bar panel: the page the native helper's panel window loads
 * (`/home/menu-bar?embed=1` — chromeless, so no rail, tab bar or action bar).
 * The index pane of the menu-bar app (`menuBarApp`, which follows the OS's
 * light/dark), so it has no segment of its own. Its body is the
 * `MenuBar.Section` slot and nothing else: the panel names no section.
 */
export const menuBarPane = Pane.define({
  route: defineRoute({ id: "menu-bar", segment: "" }),
  app: menuBarApp,
  appIndex: true,
  title: "equin",
  component: MenuBarPanelBody,
});

/** The sections, natural height, reported to the helper so its window fits. */
function PanelSections() {
  const host = useNativeHost();
  const setPanelHeight = host.kind === "present" ? host.setPanelHeight : null;
  const content = useRef<HTMLElement>(null);
  // Pushed by a ResizeObserver: the window follows the content as sections
  // load, the task field grows, or a section appears.
  useResizeObserver(
    content,
    () => {
      const el = content.current;
      if (setPanelHeight === null || el === null) return;
      void setPanelHeight(Math.ceil(el.getBoundingClientRect().height));
    },
    { deps: [setPanelHeight] },
  );
  return (
    <Stack ref={content} gap="none" className={insetClass({ pad: "xs" })}>
      <MenuBar.Section.Render />
    </Stack>
  );
}

function MenuBarPanelBody() {
  return (
    <PaneChrome pane={menuBarPane}>
      <SurfaceOverlay>
        <Surface
          level="overlay"
          // The helper's window IS the panel: it owns the corners and shadow.
          className="size-full rounded-none shadow-none ring-0"
        >
          <PanelStatus>
            <Scroll className="h-full">
              <PanelSections />
            </Scroll>
            <MenuBar.Mount.Mount />
          </PanelStatus>
        </Surface>
      </SurfaceOverlay>
    </PaneChrome>
  );
}
