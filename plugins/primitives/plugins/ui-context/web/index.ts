import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export type {
  ContributionNodeAttrs,
  RegionNodeAttrs,
} from "./internal/lineage-attrs";
export {
  appendLineage,
  BOXLESS_ATTR,
  contributionNodeAttrs,
  LINEAGE_ATTR,
  NODE_ATTR,
  readLineageNode,
  regionNodeAttrs,
} from "./internal/lineage-attrs";
export { collectLineage } from "./internal/collect-lineage";
export { collectLineageMeta } from "./internal/collect-lineage-meta";
export { collectMeta } from "./internal/collect-meta";
export type {
  CollectOutlineOptions,
  UiOutline,
  UiOutlineEntry,
} from "./internal/outline";
export {
  collectOutline,
  DEFAULT_OUTLINE_LIMIT,
  formatOutline,
} from "./internal/outline";
export type { UiContextRef, UiContextResolution } from "./internal/resolve";
export { resolveUiContext } from "./internal/resolve";
export {
  isBoxlessMarker,
  nearestOwner,
  nearestSource,
} from "./internal/marker-walk";
export { UiRegion } from "./internal/ui-region";

export default {
  description:
    "The UI-context lineage: the node model (contribution | region), its DOM attribute grammar, the portal-crossing chain helpers, the <UiRegion> producer, the collectLineage walk, and the <ui-context> token (collectMeta / serialize / parse), the page outline (collectOutline / formatOutline: every shown named control as its { path, element } pair) with its inverse resolveUiContext (found / ambiguous / gone). A neutral leaf so both the element picker (its element-picker sub-plugin) and reports/render-loop can ask 'what composed this element?' without either depending on the other.",
  contributions: [],
} satisfies PluginDefinition;
