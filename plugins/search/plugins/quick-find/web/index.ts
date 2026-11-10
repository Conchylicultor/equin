import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { QuickFindDialog } from "./components/quick-find-dialog";
export type { QuickFindDialogProps } from "./components/quick-find-dialog";
export { useSearch } from "./internal/use-search";
export type { UseSearchOptions } from "./internal/use-search";

export default {
  description:
    "Reusable quick-find search UI: the debounced useSearch hook and the <QuickFindDialog> dialog (each result a link, injected via resultActivation).",
  contributions: [],
} satisfies PluginDefinition;
