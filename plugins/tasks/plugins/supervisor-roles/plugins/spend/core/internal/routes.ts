import { defineRoute } from "@plugins/primitives/plugins/pane/core";
import { supervisorsRoute } from "@plugins/tasks/plugins/supervisor-roles/plugins/pane/core";

/**
 * The spend breakdown, opened from the Supervisors list like a role: `path`
 * is the drill path, node ids from the root (`week/supervisors/<role>`), so
 * Back and links land on a level.
 */
export const supervisorsSpendRoute = defineRoute({
  id: "supervisors-spend",
  segment: "spend/:path*",
  parent: supervisorsRoute,
});
