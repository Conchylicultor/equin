import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { prepromptsConfig } from "../shared/config";

export { prepromptsConfig } from "../shared/config";
export { PrepromptSelect } from "./components/preprompt-select";
export type { PrepromptSelectProps } from "./components/preprompt-select";
export { PrepromptGlyph } from "./components/preprompt-glyph";
export { usePreprompt } from "./internal/use-preprompt";
export { usePrepromptItems } from "./internal/items";
export { useEditPrepromptLibrary } from "./internal/use-edit-library";
export type { PrepromptItem } from "./internal/items";

export default {
  description:
    "Settings library of system-prompt snippets and a reusable picker for selecting a task's preprompt.",
  contributions: [ConfigV2.WebRegister({ descriptor: prepromptsConfig })],
} satisfies PluginDefinition;
