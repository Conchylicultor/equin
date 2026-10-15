import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { gitFields } from "../../core";
import { GitBadgeCell } from "../components/git-fields";

// How the tree's git client fields present: `git` is a glyph column (no header
// text, 28px, centred) drawing the badge of its value; `changed` is a filter
// dimension the user can switch on, not a default column.
export const gitPresentation = FieldPresentation.Register({
  owner: gitFields,
  fields: {
    git: {
      header: false,
      width: "28px",
      align: "center",
      cell: (badge) => (badge === null ? null : <GitBadgeCell badge={badge} />),
    },
    changed: { visible: false },
  },
});
