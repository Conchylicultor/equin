import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import type { PlacesState } from "@plugins/apps/plugins/file-explorer/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { filesDataAtPane, filesDataPane } from "../panes";

const appDataIcon = symbol("database");

/**
 * The App data place: one route place leading to the browsable file roots,
 * active while the surface shows App data (its landing or any root in it). It
 * names no root — the roots are the server's (`data-files.roots`).
 */
export function useAppDataPlace(): PlacesState {
  const openPane = useOpenPane();
  const landing = filesDataPane.useRouteEntry();
  const inRoot = filesDataAtPane.useRouteEntry();
  return {
    kind: "ready",
    places: [
      {
        kind: "route",
        id: "app-data",
        label: "App data",
        icon: appDataIcon,
        target: openPane.to(filesDataPane, {}, { mode: "root" }),
        active: landing !== null || inRoot !== null,
      },
    ],
  };
}
