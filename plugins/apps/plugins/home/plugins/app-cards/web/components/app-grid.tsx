import { useMemo } from "react";
import { Apps, isListedApp, useCurrentAppId } from "@plugins/apps-core/web";
import { useActivateApp } from "@plugins/apps-core/plugins/tabs/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  DataView,
  defineDataView,
  type CreateOption,
} from "@plugins/primitives/plugins/data-view/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { capsuleToolbar } from "@plugins/primitives/plugins/data-view/plugins/capsule-toolbar/web";
import {
  appRow,
  appRowOverrides,
  type AppRow,
} from "@plugins/apps-core/plugins/app-launcher/web";
import type { IconsViewOptions } from "@plugins/primitives/plugins/data-view/plugins/icons/core";
import { useHintAnchor } from "@plugins/hints/web";
import { appTileAnchor, homeGalleryAnchor } from "../../core";
import { installedApp } from "@plugins/apps-core/plugins/app-launcher/core";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { newAppPane } from "@plugins/apps/plugins/home/plugins/new-app/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");

const HOME_APPS_VIEW = defineDataView("home.apps");

/** Registers each app's whole tile (square and name) as its hint anchor. */
function useAppTileRef(row: AppRow) {
  return useHintAnchor(appTileAnchor.at(row.id));
}

/** The icons view's options: every tile is an anchor the onboarding tour can
 *  point at, and the grid ends in a New app tile. */
function homeAppViewOptions(newApp: LinkTarget): {
  icons: IconsViewOptions<AppRow>;
} {
  return {
    icons: {
      useTileRef: useAppTileRef,
      addTile: { label: "New app", icon: addIcon, activation: newApp },
    },
  };
}

export function AppGrid() {
  const openPane = useOpenPane();
  // Every way to make an app opens the New app screen.
  const newApp = openPane.to(newAppPane, {}, { mode: "root" });
  const apps = Apps.App.useContributions();
  const currentId = useCurrentAppId();
  // Lands in the grid's OWN surface tab — in desktop mode multiple Home
  // windows can be open, so the global focused tab is the wrong target.
  const activate = useActivateApp();
  const galleryRef = useHintAnchor(homeGalleryAnchor);
  const rows = useMemo(
    () => apps.filter((a) => a.id !== currentId && isListedApp(a)).map(appRow),
    [apps, currentId],
  );

  const creators: CreateOption[] = [
    {
      id: "new-app",
      label: "New app",
      icon: <Icon icon={addIcon} className="size-4" />,
      onSelect: newApp.open,
    },
  ];

  return (
    // The gallery's hint anchor: the grid with its toolbar, one box.
    <Stack gap="none" ref={galleryRef}>
      <DataView<AppRow>
        rows={rows}
        rowKey={(a) => a.id}
        // The same tile and name the app launcher draws; the client fields of
        // the kind (usage stats, …) join them.
        collection={installedApp}
        overrides={appRowOverrides}
        // Icons is the launcher (tile + name only); the table shows every field,
        // contributed ones included.
        views={["icons", "table"]}
        viewOptions={homeAppViewOptions(newApp)}
        defaultView="icons"
        toolbar={capsuleToolbar}
        searchPlaceholder="Search apps"
        storageKey={HOME_APPS_VIEW}
        // The grid only renders inside the visible (focused) Home tab, so the
        // launcher navigates that tab into the picked app in place.
        rowActivation={(row) => activate(row.entry)}
        creators={creators}
        // Every install has apps, so an empty grid is a search that matched
        // nothing — which is when building the missing app is the useful offer.
        emptyState={
          <>
            No app matches.{" "}
            <Button variant="link" aspect="inline" {...linkProps(newApp)}>
              Build one?
            </Button>
          </>
        }
      />
    </Stack>
  );
}
