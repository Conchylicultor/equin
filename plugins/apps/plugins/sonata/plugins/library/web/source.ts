import {
  defineDataView,
  liveDataSource,
} from "@plugins/primitives/plugins/data-view/web";
import { songLibrary } from "../core";

/** The library DataView's surface — its collection's `columnScope`. */
export const LIBRARY_VIEW = defineDataView("sonata.library");

/** The library DataView's live source: every song, its search box matching title and composer. */
export const songLibrarySource = liveDataSource(songLibrary, {
  searchable: ["title", "composer"],
  surface: LIBRARY_VIEW,
});
