import { hostFsVolumeInfo } from "@plugins/infra/plugins/host-fs/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { useHomeDir } from "@plugins/apps/plugins/file-explorer/plugins/browser/web";
import { displayPath } from "@plugins/apps/plugins/file-explorer/plugins/browser/core";
import {
  FileExplorer,
  type PlacesState,
} from "@plugins/apps/plugins/file-explorer/plugins/shell/web";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { fileExplorerMainCheckout } from "../../shared/resources";
import { PINNED_SOURCE, usePinnedPlaces } from "./favorites";

const homeIcon = symbol("home");
const downloadsIcon = symbol("download");
const folderIcon = symbol("folder");
const driveIcon = symbol("hard-drive");
const trashIcon = symbol("delete");

/** A source of one place that is the same everywhere: a fixed label and path. */
function fixedPlace(
  id: string,
  label: string,
  path: string,
  icon: IconRef,
): () => PlacesState {
  const state: PlacesState = {
    kind: "ready",
    places: [{ id, label, path, icon }],
  };
  return function useFixedPlace() {
    return state;
  };
}

/** The Singularity main checkout — its path is the server's to say. */
function useSingularityPlace(): PlacesState {
  const checkout = useLive(fileExplorerMainCheckout);
  const home = useHomeDir();
  const label = "Singularity";
  if (checkout.status === "error") {
    return {
      kind: "failed",
      label,
      icon: folderIcon,
      message: checkout.error.message,
    };
  }
  if (checkout.status === "loading" || home.kind === "pending") {
    return { kind: "pending" };
  }
  const path =
    home.kind === "ready"
      ? displayPath(checkout.data, home.home)
      : checkout.data;
  return {
    kind: "ready",
    places: [{ id: "singularity", label, path, icon: folderIcon }],
  };
}

/**
 * The startup volume, named as the system names it ("Macintosh HD") by
 * `host-fs.volume` — the same tuple the storage meter reads.
 */
function useStartupVolumePlace(): PlacesState {
  const volume = useLive(hostFsVolumeInfo, { path: "/" });
  switch (volume.status) {
    case "loading":
      return { kind: "pending" };
    case "unavailable":
      return {
        kind: "failed",
        label: "/",
        icon: driveIcon,
        message: volume.message,
      };
    case "error":
      return {
        kind: "failed",
        label: "/",
        icon: driveIcon,
        message: volume.error.message,
      };
    case "ready":
      return {
        kind: "ready",
        places: [
          {
            id: "startup-volume",
            label: volume.data.name,
            path: "/",
            icon: driveIcon,
          },
        ],
      };
  }
}

/** The place sources this plugin contributes, in sidebar order within each group. */
export const placeContributions = [
  FileExplorer.Places({
    id: "home",
    group: "favorites",
    usePlaces: fixedPlace("home", "Home", "~", homeIcon),
  }),
  FileExplorer.Places({
    id: "downloads",
    group: "favorites",
    usePlaces: fixedPlace(
      "downloads",
      "Downloads",
      "~/Downloads",
      downloadsIcon,
    ),
  }),
  FileExplorer.Places({
    id: "singularity",
    group: "favorites",
    usePlaces: useSingularityPlace,
  }),
  // The user's own pins, after the built-in favorites.
  FileExplorer.Places({
    id: PINNED_SOURCE,
    group: "favorites",
    usePlaces: usePinnedPlaces,
  }),
  FileExplorer.Places({
    id: "startup-volume",
    group: "locations",
    usePlaces: useStartupVolumePlace,
  }),
  // Without Full Disk Access the Trash cannot be listed; the browser says so
  // (a denied folder) rather than showing it empty.
  FileExplorer.Places({
    id: "trash",
    group: "locations",
    usePlaces: fixedPlace("trash", "Trash", "~/.Trash", trashIcon),
  }),
];
