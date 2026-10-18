import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { FileExplorer } from "@plugins/apps/plugins/file-explorer/plugins/shell/web";
import { FileBrowserSlots } from "@plugins/apps/plugins/file-explorer/plugins/browser/web";
import { ConfigV2 } from "@plugins/config_v2/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { PlacesSidebar } from "./components/places-sidebar";
import { StorageMeter } from "./components/storage-meter";
import {
  AddToFavoritesAction,
  RemoveFavoriteAction,
} from "./components/favorite-actions";
import { placeContributions } from "./internal/places";
import { PlacesSlots } from "./slots";
import { placesConfig } from "../shared/config";

export default {
  description:
    "The file explorer's Places sidebar: the places of every FileExplorer.Places source (its own: Home, Downloads, the Singularity checkout, the user's pinned favorites, the startup volume, Trash) as a DataView list in Favorites / Worktrees / Locations sections with the current folder's place active, and the startup volume's storage meter at its foot. Host paths dragged onto Favorites (HOST_PATHS_MIME) are pinned there — a folder opens itself, a file its folder with the file previewed — kept in the file-explorer places config; a pin's row offers Remove from Favorites, and the browser's row ⋯ menu Add to Favorites.",
  slots: {
    "row-actions": PlacesSlots.RowActions,
  },
  contributions: [
    FileExplorer.Sidebar({
      id: "places",
      title: "Places",
      icon: symbol("folder-special"),
      component: PlacesSidebar,
    }),
    FileExplorer.Sidebar({
      id: "storage",
      title: "Storage",
      icon: symbol("hard-drive"),
      component: StorageMeter,
    }),
    ...placeContributions,
    ConfigV2.WebRegister({ descriptor: placesConfig }),
    PlacesSlots.RowActions({
      id: "remove-favorite",
      component: RemoveFavoriteAction,
    }),
    FileBrowserSlots.RowActions({
      id: "add-to-favorites",
      component: AddToFavoritesAction,
    }),
  ],
} satisfies PluginDefinition;
