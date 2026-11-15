import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { themeCustomizerPane } from "./panes";
import { ThemeCustomizer } from "./slots";

export { ThemeCustomizer } from "./slots";
export { themeCustomizerPane } from "./panes";
export { TokenRows } from "./components/token-rows";
export type { ReadyTokenGroupEditor } from "./components/token-rows";
export { FillFromMenu } from "./components/fill-from-menu";
export {
  useTokenGroupEditor,
  useColorAdjustEditor,
} from "./internal/use-token-group-editor";
export type {
  TokenGroupEditor,
  ColorAdjustEditor,
} from "./internal/use-token-group-editor";

export default {
  description:
    "Extensible theme customization pane: per-app theme toggle, component variant pickers, search, and contributed sections, plus the token-group editor kit (useTokenGroupEditor, TokenRows, FillFromMenu) every section edits the scope's theme through.",
  // The toolbar entry point lives in the sibling `quick-theme` plugin: the
  // palette button opens the quick-switch popover, whose footer navigates here.
  contributions: [Pane.Register({ pane: themeCustomizerPane })],
  slots: { ...ThemeCustomizer, "theme-customizer": themeCustomizerPane },
} satisfies PluginDefinition;
