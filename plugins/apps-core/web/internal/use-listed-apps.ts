import { useMemo } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { isNodeData, useReorderedEntries } from "@plugins/reorder/web";
import {
  combineResources,
  mapResource,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { Apps } from "../slots";
import { useAppListing } from "./use-app-listing";
import type { ActiveApp } from "./use-active-app";

/**
 * Every app a launcher offers this user ({@link useAppListing}), in the order
 * the app rail shows them: the `Apps.App` slot's authored reorder layout
 * (`config/apps-core/app.jsonc`), apps the user hid left out. The one way to
 * list apps — the Home gallery, the launcher popover, the Desktop's launcher
 * and the menu-bar grid all read it, so no two of them can disagree.
 *
 * Never the raw registration order: that is a function of which plugins the
 * page happens to load and when (a scope's on-demand plugins land after the
 * page's own), so the same apps would list differently on two pages. Loading
 * until the layout and the listing are both known.
 */
export function useListedApps(): ResourceResult<ActiveApp[]> {
  const apps = Apps.App.useContributions();
  const listing = useAppListing();
  // The contributions carry `_pluginId` + `id`, all the reorder key needs; they
  // lack `_slot`, so widen through `unknown`.
  const order = useReorderedEntries(
    Apps.App.id,
    apps as unknown as Contribution[],
  );
  return useMemo(
    () =>
      mapResource(
        combineResources({ order, listing }),
        ({ order: { entries }, listing: isListed }) =>
          entries
            .filter((e) => !isNodeData(e))
            .map((e) => e as unknown as ActiveApp)
            .filter(isListed),
      ),
    [order, listing],
  );
}
