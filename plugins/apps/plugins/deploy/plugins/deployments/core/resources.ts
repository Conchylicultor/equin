import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { stringListField } from "@plugins/fields/plugins/string-list/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { liveCollection } from "@plugins/network/plugins/live/core";

/**
 * Every deployment, as a live collection over `deploy_deployments`: a bounded
 * window (oldest first — the order a server's list has always shown — 100 / max
 * 500) plus its `:rows` point sibling.
 *
 * - **One deployment** (the pane, its sections, the analytics gate) is
 *   `useLiveRow(deployments, deploymentId)`: a point read, so `found: false` is
 *   "this deployment no longer exists", never "outside the window".
 * - **One server's list** is `useLive(deployments, { where: { serverId } })` —
 *   `serverId` is the one filterable column, because it is the one a reader
 *   filters on.
 *
 * A deployment is one row per (composition × server), both hand-authored, so
 * the default window holds every deployment of any real server; the bound is
 * the collection's, not a promise that the set stays small.
 */
export const deployments = liveCollection("deploy.deployments", {
  // Declared by FIELDS, the row being `Deployment` (the table's columns by
  // name). `serverId` is the one listed field — the scope a reader filters by;
  // the rest ride on the row for the pane and the list's own columns.
  fields: { serverId: textField({ label: "Server" }) },
  carry: {
    fields: {
      id: textField(),
      compositionId: textField(),
      hostnames: stringListField(),
      loopbackPort: intField(),
      createdAt: dateField(),
      updatedAt: dateField(),
    },
  },
  id: "id",
  sortable: ["createdAt"],
  default: { orderBy: [["createdAt", "asc"]], limit: 100 },
  maxLimit: 500,
});
