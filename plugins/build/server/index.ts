import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { IdKinds } from "@plugins/ids/server";
import { buildRunIdKind } from "@plugins/build/plugins/run-ledger/core";
import { buildHistoryServed } from "./internal/build-history-resource";
import { buildConfig } from "../shared";
import { BUILD_CATEGORY_ID } from "../core/task-category";

export default {
  description:
    "Build, portable half: the build-run id kind, the build config, the Build task category and the build.history collection over build_runs — what a host without the computer serves too. Running builds (the jobs, the routes, the auto-build reconcile) is build/machine.",
  portable: true,
  contributions: [
    IdKinds.Kind({ kind: buildRunIdKind }),
    ConfigV2.Register({ descriptor: buildConfig }),
    TaskCategory({ id: BUILD_CATEGORY_ID, label: "Build", order: 7 }),
    ...buildHistoryServed.declare,
  ],
} satisfies ServerPluginDefinition;
