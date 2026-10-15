import type { SealContributions } from "@plugins/framework/plugins/web-sdk/core";
import type { ViewSourceEntry, ViewTypeMeta } from "../../core";

/**
 * The view-types one source entry can offer, in menu order: that entry's
 * registered contributions ∩ its `views` whitelist.
 *
 * **The ONE gate.** Both places that offer a type to the user read it — the `+`
 * add menu (`availableSources`) and the active view's settings popover
 * (`variantsFor`) — so the two cannot drift: a surface can never switch a view
 * into a type it could not have created.
 */
export function usableTypes<T extends ViewTypeMeta>(
  entry: ViewSourceEntry<T>,
): SealContributions<T>[] {
  return entry.contributions
    .filter((c) => (entry.views ? entry.views.includes(c.type) : true))
    .slice()
    .sort(
      (a, b) =>
        (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title),
    );
}
