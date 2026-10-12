import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { IdKinds as IdKindsSlots } from "./slots";

export { IdKinds } from "./slots";
export type { IdPresenter, IdReferentState } from "./slots";
export { useIdKinds, useIdPresenters } from "./hooks";

export default {
  description:
    "The id-kind registry, web half: IdKinds.Kind registers a declared kind and IdKinds.Presenter how its ids render and open (icon, useReferent, useTarget); useIdKinds() / useIdPresenters() read them at render time.",
  slots: IdKindsSlots,
} satisfies PluginDefinition;
