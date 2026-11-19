import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { DebugApp } from "@plugins/apps/plugins/debug/plugins/shell/web";
import { ConfigV2 } from "@plugins/config_v2/web";
import { buildConfig } from "../core";
import { BuildButton } from "./components/build-button";
import { UpdateGlance } from "./components/update-button";
import { UpdatePolicyRoot } from "./components/update-policy-root";
import { useBuildActivity } from "./hooks/use-build-activity";
import { useOutOfMemoryHealth } from "./hooks/use-out-of-memory-health";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { buildPane, buildDetailPane } from "./panes";
import { BuildDetail } from "./slots";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { IdKinds } from "@plugins/ids/web";
import { buildRunIdKind } from "@plugins/build/plugins/run-ledger/core";

export { BuildDetail as BuildDetailSlots } from "./slots";
export { buildPane, buildDetailPane } from "./panes";
export { useStaleFrontend } from "./hooks/use-stale-frontend";

export default {
  collapsed: true,
  description:
    "Trigger `./equin build` from the toolbar. Tabs on an older build update themselves: useTabUpdate() is the one verdict (current / available / required / fault) of the build this tab runs against the build served, and the page's UpdatePolicyRoot (Core.Root) reloads into the served build at a safe moment through reload-readiness's quietReload — hidden, or visible and idle, or at once when the old build already fails here — with a neutral Update pill the whole time an update is pending (naming what holds it, if anything) and a red fault, for developers only, when plugins fail on the served build itself. The health report's Update not deployed row: attention while this namespace's newest closed build ended out of memory (the computer ran out of memory checking the update — the commit still running, and that closing other apps frees memory), pulsing while the retry runs; absent otherwise.",
  contributions: [
    IdKinds.Kind({ kind: buildRunIdKind }),
    ActionBar.Item({
      id: "build",
      component: BuildButton,
    }),
    // The collapsed floating bar hides the Build button; these keep a running /
    // failed build (a ring around the health dot) and an update the user can
    // act on (the Build tray holding only its Update pill, beside it) visible
    // anyway.
    ActionBar.Activity({ id: "build", useActivity: useBuildActivity }),
    ActionBar.Glance({ id: "reload", component: UpdateGlance }),
    // A deploy the computer ran out of memory for, told to the user where
    // they look: nothing deployed, and only free memory helps. Absent
    // otherwise.
    HealthReport.Row({
      kind: "status",
      id: "build-out-of-memory",
      title: "Update not deployed",
      useStatus: useOutOfMemoryHealth,
    }),
    // The reload policy: a tab on an older build updates itself at a safe
    // moment, once per page.
    Core.Root({ component: UpdatePolicyRoot, scope: "page" }),
    Pane.Register({ pane: buildPane }),
    Pane.Register({ pane: buildDetailPane }),
    // Build panes live in the Debug app (`/debug/build`), alongside the other
    // developer-facing observability surfaces (Reports, Logs, Profiling). The
    // action-bar button links there via `buildRoute.link(debugApp, …)`; this is
    // the in-app entry point for the same panes.
    DebugApp.Sidebar({
      id: "build",
      title: "Builds",
      icon: symbol("build"),
      opens: { pane: buildPane, params: {} },
    }),
    ConfigV2.WebRegister({ descriptor: buildConfig }),
  ],
  slots: { ...BuildDetail, build: buildPane, "build-detail": buildDetailPane },
} satisfies PluginDefinition;
