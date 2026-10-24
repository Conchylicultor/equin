import { useMemo } from "react";
import { Apps, useCurrentAppId, useHomeApp } from "@plugins/apps-core/web";
import { useActivateApp } from "@plugins/apps-core/plugins/tabs/web";
import {
  DataView,
  defineDataView,
  fieldOverrides,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  HostedToolbar,
  HostedToolbarParts,
} from "@plugins/primitives/plugins/data-view/core";
import {
  appRow,
  type AppRow,
} from "@plugins/apps-core/plugins/app-launcher/web";
import { installedApp } from "@plugins/apps-core/plugins/app-launcher/core";
import { AppIconAvatar } from "@plugins/apps-core/plugins/app-icon/web";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import type { IconsViewOptions } from "@plugins/primitives/plugins/data-view/plugins/icons/core";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { insetClass } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useNativeHost } from "@plugins/menu-bar/web";
import { menuBarInstalled } from "@plugins/menu-bar/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { AppGridActions } from "./pin-action";

const MENU_BAR_APPS_VIEW = defineDataView("menu-bar.apps");

/**
 * The app's tile — the icon Home and the launcher draw — with the app's own
 * badge (`Apps.App` `badge`: unread mail, a config conflict) on its corner.
 */
const appGridOverrides = fieldOverrides(installedApp, {
  icon: {
    leading: true,
    cell: (row: AppRow) => {
      const Badge = row.entry.badge;
      return (
        <span className="relative block size-full">
          <AppIconAvatar icon={row.icon} appId={row.id} />
          {Badge && (
            <Pin to="top-right" outset decorative>
              <Badge />
            </Pin>
          )}
        </span>
      );
    },
  },
});

/** No toolbar band: the panel is too small for one, so the frame is the grid. */
function GridFrame({ body }: HostedToolbarParts) {
  return body;
}

const GRID_TOOLBAR: HostedToolbar = { kind: "hosted", frame: GridFrame };

/** A menu's grid: four cells sharing the panel's width. */
const GRID_VIEW_OPTIONS: { icons: IconsViewOptions<AppRow> } = {
  icons: { menu: { columns: 4 } },
};

/** An app's own URL, absolute — what the helper opens in the browser. */
function appUrl(basePath: string): string {
  return new URL(basePath, window.location.origin).href;
}

/**
 * Every app as the compact icons DataView — the tile and name Home
 * and the launcher draw, four to a row, scrolling past four rows. Dragging a
 * tile reorders the grid (persisted per view, `view-order`). A tile opens its
 * app: its own OS window (`launchApp`) — main keeps a shim for every app ahead
 * of any click, so that is every app once its first sync has run; in the
 * browser through the helper for an app with no shim yet; in this tab when
 * the panel is not inside the helper. Each tile carries a pin on hover
 * (`AppGridActions`: keep it in the Dock, hidden once pinned or where the
 * host cannot pin).
 *
 * The desktop (a surface-mode app) is a tile like any other: its URL is its
 * base path as a route prefix (`/desktop` — the desktop with no window open).
 */
export function MenuBarAppGrid() {
  const apps = Apps.App.useContributions();
  const currentId = useCurrentAppId();
  // The composition's home (the gallery) is what the footer opens, so it is
  // not a tile; nor is the app the panel itself is drawn in.
  const home = useHomeApp();
  const homeId = home.kind === "app" ? home.app.id : undefined;
  const activate = useActivateApp();
  const host = useNativeHost();
  const installed = useLive(menuBarInstalled);
  const rows = useMemo(
    () => apps.filter((a) => a.id !== currentId && a.id !== homeId).map(appRow),
    [apps, currentId, homeId],
  );
  // The helper is still answering: a tile cannot know yet where it opens.
  if (host.kind === "pending")
    return <Loading variant="block" className="h-40 w-full" />;
  const openUrl = host.kind === "present" ? host.openUrl : null;
  const launchApp = host.kind === "present" ? host.launchApp : null;
  // A helper that launches installed apps: a tile cannot know where it opens
  // until the installed set is known either.
  const installedIds =
    launchApp === null
      ? []
      : foldResource(installed, {
          loading: () => null,
          // The section's error boundary shows it: a tile cannot know where
          // it opens without the installed set.
          error: (err) => {
            throw err;
          },
          // A transport without the computer has no installed apps to launch.
          unavailable: () => [],
          ready: (d) => d.appIds,
        });
  if (installedIds === null)
    return <Loading variant="block" className="h-40 w-full" />;
  const rowActivation = (row: AppRow): Activation => {
    if (launchApp !== null && installedIds.includes(row.id)) {
      const url = appUrl(row.entry.app.basePath);
      return { open: () => void launchApp(row.id), href: () => url };
    }
    if (openUrl === null) return activate(row.entry);
    const url = appUrl(row.entry.app.basePath);
    return { open: () => void openUrl(url), href: () => url };
  };
  return (
    // Four rows of tiles, then the grid scrolls inside the panel.
    <Scroll
      className={cn(
        "max-h-[18.5rem] overscroll-contain",
        // A region on the `xs` rail (the DataView's bands follow it, owing
        // nothing more); the grid section pads its own foot.
        "rail-x-xs",
        insetClass({ t: "xs" }),
      )}
    >
      <DataView<AppRow>
        rows={rows}
        rowKey={(a) => a.id}
        collection={installedApp}
        overrides={appGridOverrides}
        views={["icons"]}
        defaultView="icons"
        density="compact"
        viewOptions={GRID_VIEW_OPTIONS}
        toolbar={GRID_TOOLBAR}
        storageKey={MENU_BAR_APPS_VIEW}
        rowActivation={rowActivation}
        itemActions={AppGridActions}
        emptyState="No apps installed."
      />
    </Scroll>
  );
}
