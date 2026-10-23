import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { idChip } from "./internal/id-chip";
export { rowReferent } from "./internal/row-referent";

export default {
  description:
    "Id chips, web half: idChip({ presenter, surfaces, component? }) mints a kind's IdKinds.Presenter together with its inline chip — the pattern derived from the kind (never re-typed), a generic title + icon chip unless the family brings its own component, optionally carrying a first-meeting hint (declared to the hints engine, anchored on and requested by every resolved chip). rowReferent folds a live by-id row read into a presenter's referent state.",
  contributions: [],
} satisfies PluginDefinition;
