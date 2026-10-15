import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { CompositionDetail } from "@plugins/apps/plugins/studio/plugins/compositions/web";
import { releaseDetailPane } from "./panes";
import { ReleaseSection } from "./components/release-section";
import { ReleaseHistorySection } from "./components/release-history-section";
import { ReleaseDetail } from "./slots";
import { investigateReleaseHistory } from "./internal/investigate";

export { ReleaseDetail } from "./slots";
export { releaseDetailPane } from "./panes";

export default {
  description:
    "Release sections of the Studio composition detail pane (target picker + Run, and this composition's run history), plus the run-detail pane hosting the info / logs / artifact sections.",
  contributions: [
    Pane.Register({ pane: releaseDetailPane }),
    CompositionDetail.Section({
      id: "release",
      label: "Build & serve",
      component: ReleaseSection,
    }),
    CompositionDetail.Section({
      id: "release-history",
      label: "Release history",
      component: ReleaseHistorySection,
    }),
    // A failed run's Investigate action, in every list of release history.
    investigateReleaseHistory,
  ],
  slots: { ...ReleaseDetail, "release-detail": releaseDetailPane },
} satisfies PluginDefinition;
