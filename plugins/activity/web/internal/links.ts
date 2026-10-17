import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import type { FieldsRecord } from "@plugins/fields/core";
import type { LiveArm } from "@plugins/network/plugins/live/core";
import { appLink } from "@plugins/apps-core/plugins/tabs/web";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import type { ActivityRow } from "../../core";

/**
 * Where a record of `arm` goes when clicked, in every list of activity: its
 * own app's detail pane, by app-rooted URL (`pane.link(app, params)`). A list
 * of activity mixes records of several apps and is hosted by yet another (the
 * Home page), so a row navigates the tab INTO the record's app — never opens
 * its pane inside the host's surface. A link: ⌘/middle-click opens it in a
 * browser tab.
 *
 * It is data-view's `CollectionRowActivation` over the arm, typed by the
 * activity row.
 */
export function activityLinks(
  arm: LiveArm<ActivityRow, FieldsRecord, string>,
  url: (row: ActivityRow) => string,
): Contribution {
  const link = (row: unknown): LinkTarget => appLink(url(row as ActivityRow));
  return DataViewSlots.CollectionRowActivation({
    id: "open",
    owner: arm,
    useActivation: () => link,
  });
}
