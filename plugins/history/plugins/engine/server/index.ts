import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { IdKinds } from "@plugins/ids/server";
import { versionIdKind } from "../core";
import { listVersions, restoreVersion } from "../core";
import { handleListVersions } from "./internal/handle-list-versions";
import { handleRestoreVersion } from "./internal/handle-restore-version";
import {
  historyVersionServed,
  historyVersionsServed,
} from "./internal/resources";
import { entityVersionsRetention } from "./internal/retention";

export { defineHistorySource } from "./internal/registry";
export type { HistorySource } from "./internal/registry";
export { recordVersion, deleteVersions } from "./internal/record-version";
export { _entityVersions } from "./internal/tables";

export default {
  portable: true,
  description:
    "Domain-agnostic versioning substrate: the entity_versions table, a defineHistorySource registry, time-bucketed recordVersion + deleteVersions, the live history.versions timeline and history.version value, and the restore (plus an e2e-only list) endpoints, and the 30-day retention sweep (its growth bound).",
  register: [entityVersionsRetention],
  contributions: [
    IdKinds.Kind({ kind: versionIdKind }),
    ...historyVersionsServed.declare,
    ...historyVersionServed.declare,
  ],
  httpRoutes: {
    [listVersions.route]: handleListVersions,
    [restoreVersion.route]: handleRestoreVersion,
  },
} satisfies ServerPluginDefinition;
