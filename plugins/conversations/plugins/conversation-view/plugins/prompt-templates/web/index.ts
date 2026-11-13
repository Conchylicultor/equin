import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { PromptEditorSlots } from "@plugins/primitives/plugins/prompt-editor/web";
import { ConfigV2 } from "@plugins/config_v2/web";
import { FloatingTemplateChips } from "./components/prompt-template-chips";
import { promptTemplatesConfig } from "../shared/config";

export { TemplateChipBar } from "./components/template-chip-bar";
export type { TemplateChipBarProps } from "./components/template-chip-bar";
export { TemplateChip } from "./components/template-chip";
export type {
  TemplateChipItem,
  TemplateChipProps,
} from "./components/template-chip";

export default {
  description:
    "Template chips inside the prompt editor that prepend text to the draft. A floating icon expands on hover to reveal available templates. Exports the chip bar itself (TemplateChipBar: usage-ranked pinned split chips plus the hover panel of every template and the config gear, always drawn — even with no templates; the panel lists every template (click inserts, ➤ sends) and, where the host lets it, manages them in place: + New template (prefilled from the draft) and ✎ on each row to rename, rewrite or delete it, sized to its content as it changes) and its one split chip (TemplateChip: ✎ name inserts, ➤ sends) for other template-like surfaces.",
  contributions: [
    PromptEditorSlots.FloatingAction({
      id: "prompt-templates",
      requires: [],
      component: FloatingTemplateChips,
    }),
    ConfigV2.WebRegister({ descriptor: promptTemplatesConfig }),
  ],
} satisfies PluginDefinition;
