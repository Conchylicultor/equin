import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { activityPresentation } from "./internal/presentation";

export { ActivityDataView } from "./components/activity-data-view";
export type { ActivityDataViewProps } from "./components/activity-data-view";
export { activityLinks } from "./internal/links";

export default {
  description:
    "The Recent activity surface: <ActivityDataView> over the `activity` union window (base fields presented once here; each kind's fields derived from its arm and its entity's exposures, with no list code), and activityLinks — where an arm's rows go (data-view's CollectionRowActivation over the arm, an app-rooted link into the record's own app).",
  contributions: [activityPresentation],
} satisfies PluginDefinition;
