import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { rowKind } from "@plugins/network/plugins/live/core";

/**
 * The kind of row the browser's tree lists: one entry of a listed folder
 * (`EntryRow`), its path its id. Rows are no database data, so this is a row
 * kind (a collection with no server), declared once: every list of entries —
 * and every plugin adding client fields to them (`clientFields(fileEntry, …)`,
 * the git status) — names it.
 *
 * Only the fields that ARE row properties are declared here (`name`, `path`);
 * the rest of the columns (Kind, Modified, Size, …) are values computed from
 * the row and the tree's context, so the tree lists them as `extraFields`.
 */
export const fileEntry = rowKind("file-explorer.entry", {
  fields: {
    name: textField({ label: "Name", primary: true }),
    path: textField({ label: "Path" }),
  },
  // `kind` (file / dir) is carried for the client fields reading it; the
  // Kind COLUMN is a different thing (the kind in words), listed by the tree.
  carry: { fields: { id: textField(), kind: textField() } },
  id: "id",
});
