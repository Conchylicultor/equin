import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { fileEntry } from "../../core";

// How the `fileEntry` row kind's own fields present in every list of entries:
// the path is a dimension the user can switch on, not a default column.
export const fileEntryPresentation = FieldPresentation.Register({
  owner: fileEntry,
  fields: { path: { visible: false } },
});
