import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { DynamicEnum } from "@plugins/fields/plugins/dynamic-enum/plugins/config/web";
import { DynamicFlags } from "@plugins/fields/plugins/dynamic-flags/plugins/config/web";
import { modelProviderConfig } from "../shared/config";
import { ModelCorruptionReporter } from "./components/corruption-reporter";
import {
  useModelChoiceOptions,
  useVisibleModelFlagOptions,
} from "./internal/config-options";

export {
  useVisibleModels,
  useDefaultModel,
  useSetDefaultModel,
} from "./internal/hooks";
export { familyClass } from "./internal/family-class";
export { useModelCatalog } from "./internal/catalog";
export { useModelItems } from "./internal/items";
export { useModelChoiceOptions } from "./internal/config-options";
export type { ModelItem } from "./internal/items";
export { ModelSelect } from "./components/model-select";
export { ModelChoiceLabel } from "./components/model-choice-label";
export type { ModelSelectProps } from "./components/model-select";

export default {
  description:
    "Model pickers and labels over the live model catalog: useModelCatalog (the pushed, preloaded catalog), useVisibleModels / useModelItems / ModelSelect / ModelChoiceLabel (families with today's version as a hint, pinned versions the user turned on), and the corruption reporter for malformed stored models.",
  contributions: [
    ConfigV2.WebRegister({ descriptor: modelProviderConfig }),
    // Both settings offer the live catalog, so neither config lists a model.
    DynamicEnum.Options({
      field: modelProviderConfig.fields.defaultModel,
      useOptions: useModelChoiceOptions,
    }),
    DynamicFlags.Options({
      field: modelProviderConfig.fields.visibleModels,
      useOptions: useVisibleModelFlagOptions,
    }),
    Core.Root({ component: ModelCorruptionReporter }),
  ],
} satisfies PluginDefinition;
