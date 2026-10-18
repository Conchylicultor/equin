import type { PlaceGroup } from "@plugins/apps/plugins/file-explorer/plugins/shell/web";
import type { IconRef } from "@plugins/ui/plugins/icons/core";

/** One place as a row: resolved, or a failed source (listed, saying why). */
export interface PlaceRow {
  id: string;
  /** The `FileExplorer.Places` source it comes from. */
  source: string;
  /** Its id within that source; `null` for a source that failed. */
  placeId: string | null;
  group: PlaceGroup;
  icon: IconRef;
  label: string;
  /** Where it leads; `null` for a place that failed to resolve. */
  path: string | null;
  /** The file it previews in that folder, if it is a file. */
  open: string | null;
  message: string | null;
}
